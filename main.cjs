'use strict';
const {app,BrowserWindow,screen,session,desktopCapturer,ipcMain,Tray,Menu,nativeImage}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {getLyrics}=require('./lyrics.cjs');
const PORT=43891, QA=process.argv.includes('--qa'), PROBE=process.argv.includes('--probe');
const ROOT=__dirname;
const TIME_ORIGIN=Date.now();
app.setName('SpotifyFloat');
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
// Keep Chromium compositing and WebGPU on the discrete adapter on hybrid PCs.
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('use-webgpu-power-preference','default-high-performance');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features','CalculateNativeWinOcclusion');
let config={}, windows=[], tray=null, active=false, server=null, request=null, pendingCommands=[];
let nativeAudio=null,audioRetry=null,audioBuffer=Buffer.alloc(0),audioGeneration=0;
const nativeStatus={connected:false,source:'Spotify',pid:null,error:null,frames:0};
let state={track:null,position:0,isPlaying:false,receivedAt:Date.now(),lyrics:null,palette:null};
const telemetry=new Map(), cache=new Map();
let configPath, logPath, gpuInfo=null;
function log(message){try{if(fs.existsSync(logPath)&&fs.statSync(logPath).size>200000)fs.renameSync(logPath,logPath+'.old');fs.appendFileSync(logPath,new Date().toISOString()+' '+message+'\n');}catch{}}
function saveConfig(){fs.writeFileSync(configPath,JSON.stringify(config,null,2));}
function broadcast(){for(const win of windows)if(!win.isDestroyed())win.webContents.send('stage-state',state);}
function displays(){return screen.getAllDisplays().map(d=>({id:d.id,label:d.label,bounds:d.bounds,scaleFactor:d.scaleFactor,rotation:d.rotation,refreshRate:d.displayFrequency,colorDepth:d.colorDepth,colorSpace:d.colorSpace,internal:d.internal}));}
function selectedDisplays(){const all=screen.getAllDisplays().sort((a,b)=>a.bounds.x-b.bounds.x);const left=all.find(d=>d.bounds.height>d.bounds.width)||all[0];const right=all.filter(d=>d.id!==left.id).sort((a,b)=>b.bounds.x-a.bounds.x)[0]||left;return {left,right};}
function stageConfig(role,display,preview=false){const portrait=role==='lyrics'||role==='combined'&&display.bounds.height>display.bounds.width;return {role,renderWidth:portrait?2160:3840,renderHeight:portrait?3840:2160,refreshRate:display.displayFrequency||60,displayId:display.id,hdrCapable:display.colorDepth>=30||/HDR|PQ|HLG/i.test(display.colorSpace||'')?true:null,colorSpace:display.colorSpace||'',offset:Number.isFinite(config.offset)?config.offset:300,preview,captureEnabled:false,nativeAudio:true,timeOrigin:TIME_ORIGIN,opaqueComposite:!process.argv.includes('--test-hdr-overlay')};}
function makeWindow(role,display,preview=false){
  const bounds=preview?{x:display.bounds.x,y:display.bounds.y,width:role==='lyrics'?720:1280,height:role==='lyrics'?1280:720}:display.bounds;
  const stage=stageConfig(role,display,preview);
  const win=new BrowserWindow({...bounds,title:role==='combined'?'Spotify Float · Lyrics and Waveform':role==='lyrics'?'Spotify Float · Lyrics':'Spotify Float · Waveform',frame:false,backgroundColor:'#05070c',show:false,fullscreen:!preview,kiosk:false,alwaysOnTop:false,autoHideMenuBar:true,webPreferences:{preload:path.join(ROOT,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,partition:'persist:spotify-stage-'+role,additionalArguments:['--stage-config='+Buffer.from(JSON.stringify(stage)).toString('base64')]}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',event=>event.preventDefault());
  win.webContents.on('render-process-gone',(_,detail)=>log('Renderer stopped: '+role+' '+detail.reason));
  win.webContents.on('console-message',(_,level,message)=>{if(level>=2)log('Renderer '+role+': '+message.slice(0,400));});
  const ses=win.webContents.session;
  ses.setPermissionRequestHandler((contents,permission,callback)=>callback(contents===win.webContents && ['media','display-capture'].includes(permission)));
  ses.setDisplayMediaRequestHandler(async (req,callback)=>{
    if(preview || req.frame?.top?.frameTreeNodeId!==win.webContents.mainFrame.frameTreeNodeId || !req.audioRequested){callback(null);return;}
    try {
      const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:0,height:0}});
      const source=sources.find(s=>String(s.display_id)===String(display.id))||sources[0];
      if(!source){callback(null);return;}
      callback({video:source,audio:'loopback'});
    } catch(error){log('Audio capture setup: '+error.message);callback(null);}
  });
  win.webContents.once('did-finish-load',()=>{win.webContents.send('stage-state',state);if(!preview){win.show();if(role==='waveform'&&stage.captureEnabled)win.webContents.executeJavaScript('window.__stageTest?.captureAudio?.()',true).catch(error=>log('Audio activation: '+error.message));}});
  win.loadFile(path.join(ROOT,'renderer','index.html'),{query:{role,preview:preview?'1':'0'}});
  win.on('closed',()=>{windows=windows.filter(w=>w!==win);if(active&&!windows.length)active=false;});
  return win;
}
function stopNativeAudio(){audioGeneration++;clearTimeout(audioRetry);audioRetry=null;const child=nativeAudio;nativeAudio=null;child?.kill();audioBuffer=Buffer.alloc(0);nativeStatus.connected=false;}
function startNativeAudio(){
  if(!active||QA||PROBE)return;stopNativeAudio();const generation=audioGeneration;
  const helper=app.isPackaged?path.join(process.resourcesPath,'SpotifyAudio.exe'):path.join(ROOT,'native','SpotifyAudio.exe');
  if(!fs.existsSync(helper)){nativeStatus.error='Spotify audio helper unavailable';log(nativeStatus.error);return;}
  const child=spawn(helper,[],{windowsHide:true,stdio:['ignore','pipe','pipe']});nativeAudio=child;nativeStatus.error=null;
  child.stderr.on('data',chunk=>{if(generation!==audioGeneration)return;const text=String(chunk).trim();const match=/ready pid=(\d+)/.exec(text);if(match){nativeStatus.pid=Number(match[1]);log('Spotify-only process audio ready pid='+nativeStatus.pid);}else if(text){nativeStatus.error=text.slice(0,200);log('Process audio: '+nativeStatus.error);}});
  child.stdout.on('data',chunk=>{
    if(generation!==audioGeneration)return;audioBuffer=Buffer.concat([audioBuffer,chunk]);
    while(audioBuffer.length>=3108){
      if(audioBuffer.readUInt32LE(0)!==0x46415455){audioBuffer=audioBuffer.subarray(1);continue;}
      const frame=audioBuffer.subarray(0,3108);audioBuffer=audioBuffer.subarray(3108);nativeStatus.connected=true;nativeStatus.frames++;
      const audio={sequence:frame.readUInt32LE(4),rms:frame.readFloatLE(8),bass:frame.readFloatLE(12),treble:frame.readFloatLE(16),musicRms:frame.readFloatLE(20),musicPeak:frame.readFloatLE(24),bassRms:frame.readFloatLE(28),bassAmplitude:frame.readFloatLE(32),wave:new Uint8Array(frame.subarray(36,2084)),fft:new Uint8Array(frame.subarray(2084,3108)),connected:true,normalized:true,peakReference:'live-music-window',source:'Spotify',pid:nativeStatus.pid};
      state.audio=audio;for(const win of windows)if(!win.isDestroyed())win.webContents.send('stage-state',{audio});
    }
  });
  child.on('error',error=>{nativeStatus.error=error.message;log('Native audio launch: '+error.message);});
  child.on('exit',()=>{if(generation!==audioGeneration)return;nativeAudio=null;nativeStatus.connected=false;state.audio={rms:0,bass:0,treble:0,connected:false,source:'Spotify',pid:null};for(const win of windows)if(!win.isDestroyed())win.webContents.send('stage-state',{audio:state.audio});if(active)audioRetry=setTimeout(startNativeAudio,1500);});
}
function closeStage(){active=false;stopNativeAudio();const old=windows;windows=[];for(const win of old)if(!win.isDestroyed())win.destroy();telemetry.clear();}
function currentMode(){return screen.getAllDisplays().length===1||config.mode==='single'?'single':'dual';}
function openStage(){if(active)return;active=true;const {left,right}=selectedDisplays();windows=currentMode()==='single'?[makeWindow('combined',right)]:[makeWindow('lyrics',left),makeWindow('waveform',right)];startNativeAudio();log('Opened '+currentMode()+' stage: '+JSON.stringify(displays()));}
function selectMode(mode){if(!['single','dual'].includes(mode))return;config.mode=mode;saveConfig();closeStage();openStage();}
function toggle(){active?closeStage():openStage();}
async function lyricsFallback(track){
  request?.abort();const controller=new AbortController();request=controller;
  const key=track.id;
  if(cache.has(key)){state.lyrics=cache.get(key);broadcast();return;}
  const timeout=setTimeout(()=>controller.abort(),12000);
  try {
    const lyrics=await getLyrics(track,controller.signal);
    if(controller.signal.aborted||state.track?.id!==key||state.lyrics?.source==='Spotify')return;
    cache.set(key,lyrics);while(cache.size>32)cache.delete(cache.keys().next().value);
    state.lyrics=lyrics;broadcast();log('Lyrics '+lyrics.source+' synced='+lyrics.synced+' lines='+lyrics.lines.length);
  } catch(error){if(!controller.signal.aborted&&state.track?.id===key){state.lyrics={lines:[],synced:false,source:'none',instrumental:false};broadcast();}}
  finally{clearTimeout(timeout);if(request===controller)request=null;}
}
async function artworkPalette(track){
  if(!track.cover)return;
  try{
    const response=await fetch(track.cover,{signal:AbortSignal.timeout(7000)});
    if(!response.ok)return;
    const buffer=Buffer.from(await response.arrayBuffer());if(buffer.length>2000000)return;
    const image=nativeImage.createFromBuffer(buffer).resize({width:48,height:48});
    if(image.isEmpty())return;
    const bitmap=image.getBitmap(),buckets=Array.from({length:18},()=>({weight:0,r:0,g:0,b:0}));
    for(let i=0;i<bitmap.length;i+=4){
      const r=bitmap[i+2]/255,g=bitmap[i+1]/255,b=bitmap[i]/255,max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
      if(delta<.08||max<.15||max>.98&&delta<.15)continue;
      const hue=((max===r?(g-b)/delta:max===g?(b-r)/delta+2:(r-g)/delta+4)*60+360)%360;
      const weight=delta*(.25+max),bucket=buckets[Math.floor(hue/20)];bucket.weight+=weight;bucket.r+=r*weight;bucket.g+=g*weight;bucket.b+=b*weight;
    }
    const ranked=buckets.filter(x=>x.weight>0).sort((a,b)=>b.weight-a.weight).slice(0,3);
    if(state.track?.id!==track.id||!ranked.length)return;
    state.palette={colors:ranked.map(bucket=>'#'+[bucket.r,bucket.g,bucket.b].map(channel=>Math.round(channel/bucket.weight*255).toString(16).padStart(2,'0')).join(''))};broadcast();
  }catch{}
}
function acceptState(body){
  const input=body?.track;
  if(!input||typeof input.id!=='string'||input.id.length>160)return;
  const track={id:input.id,title:String(input.title||'').slice(0,500),artist:String(input.artist||'').slice(0,500),album:String(input.album||'').slice(0,500),cover:typeof input.cover==='string'&&/^https:\/\/i\.scdn\.co\//.test(input.cover)?input.cover:'',duration:Math.min(12*3600*1000,Math.max(0,Number(input.duration)||0))};
  const changed=state.track?.id!==track.id;
  state={...state,track,position:Math.max(0,Math.min(track.duration||Infinity,Number(body.position)||0)),isPlaying:Boolean(body.isPlaying),receivedAt:Date.now()};
  if(changed){state.lyrics={lines:[],synced:false,source:'loading',pending:true,instrumental:false};state.palette=null;lyricsFallback(track);artworkPalette(track);}
  if(Array.isArray(body.lyrics?.lines)&&body.lyrics.lines.length<=1200 && (!body.lyrics.trackId||body.lyrics.trackId===track.id)){
    state.lyrics={lines:body.lyrics.lines.filter(l=>Number.isFinite(l.time)&&l.time>=0&&typeof l.text==='string').map(l=>({time:l.time,text:l.text.slice(0,600)})).sort((a,b)=>a.time-b.time),synced:Boolean(body.lyrics.synced),source:'Spotify',instrumental:Boolean(body.lyrics.instrumental),language:typeof body.lyrics.language==='string'?body.lyrics.language.slice(0,24):''};
    if(state.lyrics.lines.length){cache.set(track.id,state.lyrics);request?.abort();}
  }
  if(Array.isArray(body.palette?.colors)) state.palette={colors:body.palette.colors.filter(c=>/^#[0-9a-f]{6}$/i.test(c)).slice(0,3)};
  broadcast();
}
const validOrigins=new Set(['https://xpui.app.spotify.com','https://open.spotify.com','spotify:app:xpui','null']);
function startServer(){
  server=http.createServer(async(req,res)=>{
    const origin=req.headers.origin;
    if(origin&&!validOrigins.has(origin)){res.writeHead(403);res.end();return;}
    if(origin)res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Stage-Key');res.setHeader('Access-Control-Allow-Private-Network','true');
    res.setHeader('Content-Type','application/json');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    if(req.url==='/health'&&req.method==='GET'){res.end(JSON.stringify({name:'SpotifyStage',active,mode:currentMode()}));return;}
    const key=req.headers['x-stage-key'];
    if(typeof key!=='string'||key.length!==config.key.length||!crypto.timingSafeEqual(Buffer.from(key),Buffer.from(config.key))){res.writeHead(401);res.end(JSON.stringify({error:'Unauthorized'}));return;}
    if((req.url==='/diagnostics'||req.url==='/diagnostics?live=1')&&req.method==='GET'){
      // Fixed, read-only stats from our own renderer for on-demand timing QA.
      // Normal operation keeps its existing one-second telemetry cadence.
      const report=req.url.endsWith('?live=1')?(await Promise.all(windows.filter(w=>!w.isDestroyed()).map(w=>w.webContents.executeJavaScript('window.__stageTest ? ({...window.__stageTest.stats(),hdr:window.StageHDR?.stats?.()||null}) : null').catch(()=>null)))).filter(Boolean):[...telemetry.values()];
      res.end(JSON.stringify({active,mode:currentMode(),lyricOffset:Number.isFinite(config.offset)?config.offset:300,displays:displays(),state:{...state,audio:state.audio?{sequence:state.audio.sequence,rms:state.audio.rms,bass:state.audio.bass,treble:state.audio.treble,musicRms:state.audio.musicRms,musicPeak:state.audio.musicPeak,bassRms:state.audio.bassRms,bassAmplitude:state.audio.bassAmplitude,connected:state.audio.connected,normalized:state.audio.normalized,peakReference:state.audio.peakReference,source:state.audio.source,pid:state.audio.pid}:null,lyrics:state.lyrics?{...state.lyrics,lines:state.lyrics.lines.length}:null},telemetry:report,nativeAudio:nativeStatus,gpu:app.getGPUFeatureStatus(),gpuDevices:gpuInfo?.gpuDevice}));return;
    }
    if(req.method!=='POST'){res.writeHead(405);res.end();return;}
    let data='',tooLarge=false;
    for await(const chunk of req){data+=chunk;if(data.length>512000){tooLarge=true;break;}}
    if(tooLarge){res.writeHead(413);res.end();return;}
    let body={};try{body=data?JSON.parse(data):{};}catch{res.writeHead(400);res.end();return;}
    if(req.url==='/state'){
      acceptState(body);const commands=pendingCommands;pendingCommands=[];
      res.end(JSON.stringify({active,commands,wantLyrics:state.lyrics?.source!=='Spotify'}));
    }else if(req.url==='/toggle'){
      if(body.track)acceptState(body);toggle();res.end(JSON.stringify({active}));
    }else if(req.url==='/mode'){if(!['single','dual'].includes(body.mode)){res.writeHead(400);res.end(JSON.stringify({error:'Unknown mode'}));return;}selectMode(body.mode);res.end(JSON.stringify({active,mode:currentMode()}));}
    else if(req.url==='/close'){closeStage();res.end(JSON.stringify({active}));}
    else if(req.url==='/capture'){
      const out=app.isPackaged?path.join(path.dirname(process.execPath),'previews'):path.join(ROOT,'previews');fs.mkdirSync(out,{recursive:true});
      const captures=[];
      for(const win of windows){const role=new URL(win.webContents.getURL()).searchParams.get('role')||'lyrics';const image=await win.webContents.capturePage();const file=path.join(out,role+'-live.png');fs.writeFileSync(file,image.toPNG());captures.push({role,file,size:image.getSize()});}
      res.end(JSON.stringify(captures));
    }else if(req.url==='/quit'){res.end(JSON.stringify({quit:true}));setTimeout(()=>app.quit(),100);}
    else{res.writeHead(404);res.end();}
  });
  server.on('error',error=>{log('Local bridge error: '+error.message);app.quit();});server.listen(PORT,'127.0.0.1');
}
ipcMain.handle('stage-initial-state',()=>state);
ipcMain.on('stage-control',(event,action)=>{if(!windows.some(w=>w.webContents===event.sender))return;if(action==='close')closeStage();else if(action==='togglePlayback')pendingCommands.push('togglePlayback');else if(action?.type==='seek'&&Number.isFinite(action.ratio)&&state.track){pendingCommands.push({type:'seek',position:Math.round(Math.min(1,Math.max(0,action.ratio))*state.track.duration)});}});
ipcMain.on('stage-offset',(event,ms)=>{if(!windows.some(w=>w.webContents===event.sender)||!Number.isFinite(ms))return;config.offset=Math.max(-15000,Math.min(15000,ms));saveConfig();for(const win of windows)if(!win.isDestroyed())win.webContents.send('stage-state',{lyricOffset:config.offset});});
ipcMain.on('stage-audio-reconnect',event=>{if(windows.some(w=>w.webContents===event.sender))startNativeAudio();});
ipcMain.on('stage-stats',(event,stats)=>{if(windows.some(w=>w.webContents===event.sender))telemetry.set(event.sender.id,{window:event.sender.getTitle(),...stats});});
async function qa(){
  const out=process.env.STAGE_QA_DIR||path.join(path.dirname(process.execPath),'showcase');fs.mkdirSync(out,{recursive:true});
  const {left,right}=selectedDisplays();
  const scenes=[
    {name:'single-ocean',role:'combined',display:right,time:28,words:['Float in light','Ride the current','천천히 떠올라','Follow the blue']},
    {name:'portrait-lyrics',role:'lyrics',display:left,time:85,words:['光の中でゆっくり浮かぶ','風と水に身を任せて','小さな泡が空へ向かう','新しい朝の色に染まる']},
    {name:'wave-detail',role:'waveform',display:right,time:185,words:[]},
    {name:'chinese-lyrics',role:'lyrics',display:left,time:140,words:['阳光下轻轻漂浮','让水流带着文字前行','小小气泡向上升起','新的颜色慢慢展开']}
  ];
  const images=[];
  for(const scene of scenes){
    state={track:{id:'self-written-demo',title:'Spotify Float Demo',artist:'Original demonstration',album:'Self-written text and synthetic audio',duration:120000,cover:''},position:11800,isPlaying:true,receivedAt:Date.now(),lyrics:{source:'self-written demo',synced:true,lines:scene.words.map((text,i)=>({time:i*4500,text}))}};
    const win=makeWindow(scene.role,scene.display,false);windows.push(win);
    await new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
    await win.webContents.executeJavaScript('document.fonts.ready');
    await new Promise(resolve=>setTimeout(resolve,100));
    await win.webContents.executeJavaScript('window.__stageTest.fontsReady()');
    await win.webContents.executeJavaScript(`(async()=>{
      window.__stageTest.setState({track:{id:'reset-${scene.name}',duration:120000},position:11800,lyrics:${JSON.stringify(state.lyrics)}});
      for(let k=0;k<150;k++){
        const beat=Math.exp(-((k%30)/6)),phase=k*.014;
        const wave=Uint8Array.from({length:2048},(_,i)=>128+Math.round(68*(.66*Math.sin(i*.012+phase)+.22*Math.sin(i*.024+phase*.7)+.12*Math.sin(i*.038))));
        const fft=Uint8Array.from({length:1024},(_,i)=>Math.max(0,150*Math.exp(-i/160)));
        window.__stageTest.setState({audio:{connected:true,source:'synthetic demo',pid:null,normalized:true,wave,fft,rms:.24,bass:.55,treble:.24,musicRms:.08+beat*.06,bassRms:.009+beat*.04},isPlaying:true});
        window.__stageTest.renderAt(11800,${scene.time}+k/60);
        await new Promise(resolve=>setTimeout(resolve,16));
      }
      return true;
    })()`);
    const stats=await win.webContents.executeJavaScript('({stage:window.__stageTest.stats(),hdr:window.StageHDR.stats()})');
    const capture=await win.webContents.capturePage();fs.writeFileSync(path.join(out,scene.name+'.png'),capture.toPNG());
    images.push({name:scene.name,stats});win.destroy();
  }
  fs.writeFileSync(path.join(out,'showcase-verification.json'),JSON.stringify({images},null,2));app.quit();
}

app.on('window-all-closed',()=>{});
const lock=QA||PROBE||app.requestSingleInstanceLock();
if(!lock)app.quit();
else{
  if(!QA&&!PROBE){app.on('second-instance',(_,argv)=>{if(argv.includes('--single'))selectMode('single');else if(argv.includes('--dual'))selectMode('dual');else if(argv.some(a=>a.startsWith('spotify-stage:'))||argv.includes('--toggle')||!argv.includes('--background'))toggle();});app.on('window-all-closed',()=>{});}
  app.whenReady().then(async()=>{
    const stateRoot=app.isPackaged?path.join(path.dirname(process.execPath),'state'):path.join(ROOT,'state');fs.mkdirSync(stateRoot,{recursive:true});
    configPath=path.join(stateRoot,'stage-config.json');logPath=path.join(stateRoot,'stage.log');
    try{config=JSON.parse(fs.readFileSync(configPath,'utf8'));}catch{config={};}
    try{const bridge=JSON.parse(fs.readFileSync(path.join(ROOT,'bridge-settings.json'),'utf8'));if(bridge.key)config.key=bridge.key;}catch{}
    if(!config.key)config.key=crypto.randomBytes(32).toString('hex');if(process.argv.includes('--single'))config.mode='single';else if(process.argv.includes('--dual'))config.mode='dual';saveConfig();
    gpuInfo=await app.getGPUInfo('complete');
    if(PROBE){await app.getGPUInfo('complete');await new Promise(r=>setTimeout(r,500));fs.writeFileSync(process.env.STAGE_PROBE_FILE||path.join(ROOT,'display-probe.json'),JSON.stringify({displays:displays(),gpu:app.getGPUFeatureStatus()},null,2));app.quit();return;}
    if(QA){await qa();return;}
    startServer();
    try{tray=new Tray(nativeImage.createFromPath(path.join(ROOT,'renderer','assets','stage-icon-32.png')));tray.setToolTip('Spotify Float');tray.setContextMenu(Menu.buildFromTemplate([{label:'Open visuals',click:openStage},{label:'Single display: lyrics + waveform',click:()=>selectMode('single')},{label:'Dual displays: lyrics / waveform',click:()=>selectMode('dual')},{label:'Close visuals',click:closeStage},{type:'separator'},{label:'Quit',click:()=>app.quit()}]));tray.on('double-click',toggle);}catch(error){log('Tray: '+error.message);}
    if(app.isPackaged){app.setAsDefaultProtocolClient('spotify-stage');app.setLoginItemSettings({openAtLogin:true,args:['--background']});}
    else app.setAsDefaultProtocolClient('spotify-stage',process.execPath,[ROOT]);
    if(process.argv.includes('--toggle')||process.argv.some(a=>a.startsWith('spotify-stage:'))||!process.argv.includes('--background'))openStage();
    log('Bridge ready. '+JSON.stringify(displays()));
  }).catch(error=>{log('Startup: '+error.stack);app.quit();});
}
app.on('before-quit',()=>{request?.abort();closeStage();server?.close();});
