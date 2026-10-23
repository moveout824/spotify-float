/* FLOAT — Live typography and PCM visualizer. No generated song data. */
(() => {
  'use strict';
  const requestedRole=new URLSearchParams(location.search).get('role'),role=['waveform','combined'].includes(requestedRole)?requestedRole:'lyrics',hasWave=role!=='lyrics',hasLyrics=role!=='waveform';
  document.body.classList.add(role);
  const canvas = document.getElementById('stage'), ctx = canvas.getContext('2d', {alpha:false,colorSpace:'display-p3'})||canvas.getContext('2d',{alpha:false});
  // Generic foreground mask: glyphs on the portrait view, wave on landscape.
  const textMaskCanvas=document.createElement('canvas'),textMaskCtx=rasterContext(textMaskCanvas);
  const waveMaskCanvas=role==='combined'?document.createElement('canvas'):null,waveMaskCtx=waveMaskCanvas?rasterContext(waveMaskCanvas):textMaskCtx;
  const config=window.stage?.config||{};
  let width=1,height=1,dpr=1,state={track:null,position:0,isPlaying:false,receivedAt:Date.now(),lyrics:null};
  let localReceived=performance.now(), lastFrame=performance.now(), motionTime=0, offset=Number(config.lyricOffset??config.offset??0), previousId=null;
  let palette=[194,211,178], desiredPalette=[194,211,178],artOffsets=[0,0,0],desiredArtOffsets=[0,0,0], layoutCache=new Map(), lastCue=-1;
  let analyser=null, audioContext=null, captureStream=null, capturePending=false, captureFailed=false;
  let timeData=new Uint8Array(2048), frequencyData=new Uint8Array(1024), testAudio=null, testNow=null,testMotion=null;
  let rms=0,bass=0,treble=0,waveGain=1,waveEnvelope=0,lastAudioAt=-Infinity,musicSpeed=0,musicMotionSpeed=0,musicDbFS=-140,rayMotionTime=0,waveSoundActive=false,bassReference=1e-9,bassBaseline=0,lastBassRms=0,bassBody=0,kickDrive=0,kickEnvelope=0,kickHold=0,lastKickTime=-Infinity,beatTime=0,kickCount=0,renderedGlyphs=0,frames=0, hudTimer=null, captureAttempts=0,lastAudioReportAt=0;
  let oceanRaster=null,oceanRasterKey='';const bubbleSprites=new Map(),waveGradients=new Map();
  const displayWave=new Float32Array(33),targetWave=new Float32Array(33),fromWave=new Float32Array(33),waveVelocity=new Float32Array(33),fromVelocity=new Float32Array(33),filteredWave=new Float32Array(33),liveCues=new Set(),cueEntities=new Map();let cohortSerial=0,currentCohort='',displayProgress=0,waveTransition=null,waveHash=null,waveMorphAge=.035,waveThickness=1.65,wavePhaseShift=0,wavePhaseCorrelation=0;
  const waveKernel=[],kernelRadius=64,morphDuration=.035,MUSIC_SILENCE_FLOOR=1e-9,MAX_WAVE_SPEED=1.8;
  for(let i=0;i<33;i++){const center=i/32*2047,indices=[],weights=[],cutoff=.44*32/2047;let sum=0;for(let j=Math.ceil(center-kernelRadius);j<=Math.floor(center+kernelRadius);j++){const x=j-center,phase=2*Math.PI*cutoff*x,w=(Math.abs(phase)<1e-8?1:Math.sin(phase)/phase)*(.5+.5*Math.cos(Math.PI*x/(kernelRadius+1)));indices.push(clampKernelIndex(j));weights.push(w);sum+=w}waveKernel.push({indices:Int16Array.from(indices),weights:Float32Array.from(weights,w=>w/sum)})}
  function clampKernelIndex(j){if(j<0)return -j;if(j>2047)return 4094-j;return j}
  // Stable fluids: semi-Lagrangian velocity advection, viscosity and pressure
  // projection. Technique: NVIDIA GPU Gems38 / Stam; small CPU grid,30Hz.
  const FLOW_STRENGTH=.35;
  class WaterField{
    constructor(nx,ny){this.nx=nx;this.ny=ny;const n=nx*ny;this.u=new Float32Array(n);this.v=new Float32Array(n);this.a=new Float32Array(n);this.b=new Float32Array(n);this.p=new Float32Array(n);this.q=new Float32Array(n);this.div=new Float32Array(n);this.accumulator=0;this.energy=0;this.maxCurl=0;this.hotX=0;this.hotY=0;this.steps=0}
    at(field,x,y){x=clamp(x,0,this.nx-1.001);y=clamp(y,0,this.ny-1.001);const ix=x|0,iy=y|0,fx=x-ix,fy=y-iy,i=ix+iy*this.nx;return lerp(lerp(field[i],field[i+1],fx),lerp(field[i+this.nx],field[i+this.nx+1],fx),fy)}
    sample(x,y){const gx=clamp(x/width*(this.nx-1),0,this.nx-1.001),gy=clamp(y/height*(this.ny-1),0,this.ny-1.001);return {x:this.at(this.u,gx,gy)*width/this.nx,y:this.at(this.v,gx,gy)*height/this.ny}}
    inject(x,y,vx,vy,radius=95,strength=FLOW_STRENGTH){const gx=x/width*(this.nx-1),gy=y/height*(this.ny-1),rx=Math.max(1,radius/width*this.nx),ry=Math.max(1,radius/height*this.ny),du=vx*this.nx/width*.16*strength,dv=vy*this.ny/height*.16*strength;for(let j=Math.max(1,Math.floor(gy-ry));j<=Math.min(this.ny-2,Math.ceil(gy+ry));j++)for(let i=Math.max(1,Math.floor(gx-rx));i<=Math.min(this.nx-2,Math.ceil(gx+rx));i++){const d=((i-gx)/rx)**2+((j-gy)/ry)**2;if(d>1)continue;const weight=(1-d)**2,k=i+j*this.nx;this.u[k]=clamp(this.u[k]+du*weight,-55,55);this.v[k]=clamp(this.v[k]+dv*weight,-55,55)}}
    update(dt){this.accumulator=Math.min(.12,this.accumulator+dt);while(this.accumulator>=1/30){this.step(1/30);this.accumulator-=1/30}}
    step(dt){const nx=this.nx,ny=this.ny,u=this.u,v=this.v,a=this.a,b=this.b,decay=Math.exp(-dt*.29);
      a.fill(0);b.fill(0);for(let y=1;y<ny-1;y++)for(let x=1;x<nx-1;x++){const i=x+y*nx,px=x-u[i]*dt,py=y-v[i]*dt;a[i]=this.at(u,px,py)*decay;b[i]=this.at(v,px,py)*decay}
      u.set(a);v.set(b);const viscosity=.016;for(let k=0;k<2;k++){for(let y=1;y<ny-1;y++)for(let x=1;x<nx-1;x++){const i=x+y*nx;u[i]=(a[i]+viscosity*(u[i-1]+u[i+1]+u[i-nx]+u[i+nx]))/(1+4*viscosity);v[i]=(b[i]+viscosity*(v[i-1]+v[i+1]+v[i-nx]+v[i+nx]))/(1+4*viscosity)}}
      const div=this.div;this.p.fill(0);this.q.fill(0);for(let y=1;y<ny-1;y++)for(let x=1;x<nx-1;x++){const i=x+y*nx;div[i]=-.5*(u[i+1]-u[i-1]+v[i+nx]-v[i-nx])}
      for(let k=0;k<8;k++){const p=this.p,q=this.q;for(let y=1;y<ny-1;y++)for(let x=1;x<nx-1;x++){const i=x+y*nx;q[i]=(div[i]+p[i-1]+p[i+1]+p[i-nx]+p[i+nx])*.25}this.p=q;this.q=p}
      let energy=0,curlMax=0;const p=this.p;for(let y=1;y<ny-1;y++)for(let x=1;x<nx-1;x++){const i=x+y*nx;u[i]-=.5*(p[i+1]-p[i-1]);v[i]-=.5*(p[i+nx]-p[i-nx]);energy+=u[i]*u[i]+v[i]*v[i];const curl=Math.abs((v[i+1]-v[i-1]-u[i+nx]+u[i-nx])*.5);if(curl>curlMax){curlMax=curl;this.hotX=x/nx*width;this.hotY=y/ny*height}}
      this.energy=energy/(nx*ny);this.maxCurl=curlMax;this.steps++;
    }
    stats(){return {width:this.nx,height:this.ny,energy:this.energy,maxCurl:this.maxCurl,steps:this.steps,strength:FLOW_STRENGTH}}
  }
  let water=null,vortexBirthCooldown=0;
  const fluidParticles=Array.from({length:35},(_,index)=>({index,alive:false}));let fluidInitialized=false,fluidSerial=0,nextBubbleBurst=.1;
  const physics=new Map(),sprites=new Map(),cloudSprites=new Map();let hitGlyphs=[],dragged=null,pointer={x:-999,y:-999,vx:0,vy:0,at:0},pointerEnergy=0,frameMs=0,quality=1,fps=0,fpsWindowStart=performance.now(),fpsWindowFrames=0,renderScale=1,scaleY=1,lastReportAt=0,status='waiting',seekTap=null;
  const $=id=>document.getElementById(id);
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n)), lerp=(a,b,t)=>a+(b-a)*t;
  const smooth=(x)=>{x=clamp(x,0,1);return x*x*(3-2*x)};
  const hash=(str)=>{let h=2166136261;for(let i=0;i<str.length;i++)h=Math.imul(h^str.charCodeAt(i),16777619);return h>>>0};
  const random=(seed)=>{let x=Math.sin(seed*127.1+311.7)*43758.5453;return x-Math.floor(x)};
  const color=(index,a=1,l=65,s=75)=>`hsla(${palette[index%3]},${s}%,${l}%,${a})`;
  const readyFonts=new Set(),loadingFonts=new Map(),fontErrors=new Map(),kanaPattern=/[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9d]/u,hangulPattern=/\p{Script=Hangul}/u,hanPattern=/\p{Script=Han}/u,traditionalPattern=/[這們體國說為與龍萬學雲轉臺灣]/u;
  function clearFontCaches(){layoutCache.clear();sprites.clear();for(const e of cueEntities.values())e.layout=null}
  function ensureFonts(families){for(const family of families){if(readyFonts.has(family)||loadingFonts.has(family))continue;if(!document.fonts?.load){readyFonts.add(family);continue}const sample=family==='OAGothic'?'가나다Abc':family.startsWith('StageJP')?'かな漢字𠮷':family==='StageTC'?'漢字國臺':'汉字中国',promise=Promise.resolve(document.fonts.load(`800 72px "${family}"`,sample)).then(()=>{readyFonts.add(family);clearFontCaches();return true},error=>{fontErrors.set(family,String(error));console.warn('FLOAT font:',family,error?.message||error);return false});loadingFonts.set(family,promise)}return families.every(f=>readyFonts.has(f))}
  function trackScript(lines=state.lyrics?.lines||[],language=state.lyrics?.language||''){const text=lines.map(l=>l.text||'').join(''),lang=String(language).toLowerCase();if(/^ja|^jp/.test(lang)||kanaPattern.test(text))return 'ja';if(/hant|zh-tw|zh-hk|zh-mo|^tc$/.test(lang))return 'tc';if(/hans|zh-cn|zh-sg|^sc$/.test(lang))return 'sc';return traditionalPattern.test(text)?'tc':'sc'}
  function cueScript(line,hint=trackScript(),language=state.lyrics?.language||''){const text=line.text||'',lang=String(line.language??line.lang??language).toLowerCase();if(kanaPattern.test(text)||/^ja|^jp/.test(lang))return 'ja';if(hangulPattern.test(text))return 'sc';if(/hant|zh-tw|zh-hk|zh-mo|^tc$/.test(lang))return 'tc';if(/hans|zh-cn|zh-sg|^sc$/.test(lang))return 'sc';if(hint==='ja')return 'ja';return traditionalPattern.test(text)?'tc':hint}
  function glyphFamily(ch,script){if(kanaPattern.test(ch))return 'StageJP,StageJPFallback';if(hanPattern.test(ch)||/[\u3000-\u303f\uff01-\uff20\uff3b-\uff40\uff5b-\uff65]/u.test(ch))return script==='ja'?'StageJP,StageJPFallback':script==='tc'?'StageTC':'StageSC';return 'OAGothic'}
  function fontCSS(family,size){return `800 ${size}px ${family.split(',').map(f=>`"${f}"`).join(',')},OAGothic,"Malgun Gothic",sans-serif`}
  function familiesFor(line,script){const families=new Set(['OAGothic']);for(const ch of Array.from(line.text||''))for(const family of glyphFamily(ch,script).split(','))families.add(family);return Array.from(families)}
  function prepareLyricFonts(){const hint=trackScript();for(const line of state.lyrics?.lines||[])ensureFonts(familiesFor(line,cueScript(line,hint)));for(const e of cueEntities.values())if(e.cohort===currentCohort){const script=cueScript(e.line,hint);if(script!==e.script){e.script=script;e.layout=null}}}
  function fontStatus(){const text=(state.lyrics?.lines||[]).map(l=>l.text||'').join(''),detected=kanaPattern.test(text)||hanPattern.test(text)?trackScript():hangulPattern.test(text)?'ko':'latin';return {ready:Array.from(readyFonts),pending:Array.from(loadingFonts.keys()).filter(f=>!readyFonts.has(f)&&!fontErrors.has(f)),errors:Array.from(fontErrors),trackScript:detected}}
  function rasterContext(surface,alpha=true){return surface.getContext('2d',{alpha,colorSpace:'display-p3'})||surface.getContext('2d',{alpha})}
  function glyphAlpha(screenY,lifetimeFade){return clamp(screenY/height,0,1)*lifetimeFade}
  function lightMaskAlpha(age,orphanAge=null){return (1-smooth((age-26)/2))*(orphanAge===null?1:1-smooth((orphanAge-4)/3))}
  function resize(){width=innerWidth;height=innerHeight;canvas.width=Number(config.renderWidth)||(role==='lyrics'?2160:3840);canvas.height=Number(config.renderHeight)||(role==='lyrics'?3840:2160);renderScale=canvas.width/width;scaleY=canvas.height/height;dpr=renderScale;ctx.setTransform(renderScale,0,0,scaleY,0,0);textMaskCanvas.width=Math.round(canvas.width/3);textMaskCanvas.height=Math.round(canvas.height/3);textMaskCtx.setTransform(textMaskCanvas.width/width,0,0,textMaskCanvas.height/height,0,0);if(waveMaskCanvas){waveMaskCanvas.width=textMaskCanvas.width;waveMaskCanvas.height=textMaskCanvas.height;waveMaskCtx.setTransform(waveMaskCanvas.width/width,0,0,waveMaskCanvas.height/height,0,0)}layoutCache.clear();for(const e of cueEntities.values())e.layout=null;sprites.clear();bubbleSprites.clear();waveGradients.clear();oceanRasterKey='';water=new WaterField(height>width?32:48,height>width?56:27)}
  addEventListener('resize',resize);resize();
  function position(){return Math.max(0,Number(state.position||0)+(state.isPlaying?Math.max(0,(testNow??performance.now())-localReceived):0)+offset)}
  function applyState(next){
    if(!next)return;let oldPosition=position();state={...state,...next};if(next.position===undefined)state.position=oldPosition-offset;localReceived=performance.now();if(Object.hasOwn(next,'audio'))lastAudioAt=localReceived;
    if(Number.isFinite(next.lyricOffset)){offset=next.lyricOffset;$('offset-label').textContent=`Lyrics offset ${offset>=0?'+':''}${(offset/1000).toFixed(1)}s`}
    const id=state.track?.id||state.track?.title||'',changed=id!==previousId;
    if(changed){for(const e of cueEntities.values())if(e.cohort===currentCohort&&e.orphanedAt===null)e.orphanedAt=motionTime;if(previousId)waveTransition={start:motionTime,from:displayProgress};previousId=id;currentCohort=`${id}::${++cohortSerial}`;liveCues.clear();lastCue=-1;
      if(!Object.hasOwn(next,'lyrics'))state.lyrics=null;if(!Object.hasOwn(next,'palette'))state.palette=null;
      const seed=hash(id);desiredArtOffsets=[Math.sin(seed)*5,Math.sin(seed+1)*5,Math.sin(seed+2)*5];
    }
    if(state.palette?.hues?.length)desiredArtOffsets=state.palette.hues.slice(0,3).map(h=>Math.sin(h*Math.PI/180)*8);
    else if(state.palette?.colors?.length){const hs=state.palette.colors.map(hexHue).filter(Number.isFinite);if(hs.length)desiredArtOffsets=hs.map(h=>Math.sin(h*Math.PI/180)*8)}
    while(desiredArtOffsets.length<3)desiredArtOffsets.push(desiredArtOffsets[0]||0);
    if(!changed&&Math.abs(position()-oldPosition)>1800){for(const e of cueEntities.values())if(e.cohort===currentCohort&&e.orphanedAt===null)e.orphanedAt=motionTime;currentCohort=`${id}::${++cohortSerial}`;lastCue=-1;liveCues.clear()}
    if(hasLyrics&&Object.hasOwn(next,'lyrics'))prepareLyricFonts();
    updateStatus();
    if(hasWave && !config.nativeAudio && config.captureEnabled!==false && !analyser && !capturePending && !captureFailed)startAudio();
  }
  function hexHue(hex){const m=/^#?([0-9a-f]{6})$/i.exec(hex);if(!m)return NaN;const n=parseInt(m[1],16),r=(n>>16)/255,g=(n>>8&255)/255,b=(n&255)/255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;if(!d)return 190;return (((mx===r?(g-b)/d:mx===g?(b-r)/d+2:(r-g)/d+4)*60)%360+360)%360}
  function audioConnected(){return config.nativeAudio?!!state.audio?.connected:!!analyser}
  function stepMusicMotion(dt){const raw=Math.max(0,Number(state.audio?.musicRms)||0),enabled=!!state.track&&!!state.isPlaying&&audioConnected()&&raw>MUSIC_SILENCE_FLOOR;musicDbFS=20*Math.log10(Math.max(1e-7,raw));const target=enabled?clamp((musicDbFS+55)/43,0,1)*1.6:0,rate=target>musicSpeed?2.5:1;musicSpeed=lerp(musicSpeed,target,1-Math.exp(-dt*rate));musicMotionSpeed=enabled?musicSpeed:0;if(enabled)rayMotionTime+=dt*musicMotionSpeed;return enabled}
  function resetWaveState(){for(const a of [displayWave,targetWave,fromWave,waveVelocity,fromVelocity,filteredWave])a.fill(0);waveMorphAge=morphDuration;waveHash=null;waveThickness=1.65;waveGain=1;waveEnvelope=0;wavePhaseShift=wavePhaseCorrelation=0;bassReference=1e-9;bassBaseline=lastBassRms=bassBody=kickDrive=kickEnvelope=kickHold=0;lastKickTime=-Infinity}
  function alignedWaveShift(previous,incoming){let oldEnergy=0;for(let i=6;i<27;i++)oldEnergy+=previous[i]**2;if(oldEnergy<.001)return {shift:0,correlation:0};let best=-Infinity,zero=-Infinity,shift=0,bestCorrelation=0;for(let s=-12;s<=12;s++){let dot=0,energy=0,wrapped=false;for(let i=6;i<27;i++){const at=i+s;wrapped||=at<0||at>32;const value=incoming[(at+33)%33];dot+=previous[i]*value;energy+=value*value}const correlation=dot/Math.sqrt(Math.max(1e-12,oldEnergy*energy)),score=correlation-Math.abs(s)*.0035-(wrapped?Math.min(.1,Math.abs(incoming[32]-incoming[0])*.10):0);if(s===0)zero=score;if(score>best){best=score;shift=s;bestCorrelation=correlation}}return best>zero+.06?{shift,correlation:bestCorrelation}:{shift:0,correlation:zero}}
  function stepBassBeat(dt){
    beatTime+=dt;const raw=waveSoundActive?Math.max(0,Number(state.audio?.bassRms)||0):0;
    bassReference=Math.max(1e-9,raw,bassReference*Math.exp(-dt/4));const flux=Math.max(0,raw-bassBaseline)/bassReference,rise=Math.max(0,raw-lastBassRms)/bassReference;
    if(waveSoundActive&&rise>.12&&flux>.22&&beatTime-lastKickTime>.09){kickDrive=Math.max(kickDrive,clamp(rise*2.8+flux*.25,0,1));kickHold=.015;lastKickTime=beatTime;kickCount++}
    bassBaseline=lerp(bassBaseline,raw,1-Math.exp(-dt/.18));lastBassRms=raw;const bodyTarget=Math.pow(clamp(raw/bassReference,0,1),.7);bassBody=lerp(bassBody,bodyTarget,1-Math.exp(-dt/(bodyTarget>bassBody?.012:.075)));
    if(!waveSoundActive){kickDrive=0;kickHold=0}else if(kickHold>0)kickHold-=dt;else kickDrive*=Math.exp(-dt/.085);
    kickEnvelope=lerp(kickEnvelope,kickDrive,1-Math.exp(-dt/(kickDrive>kickEnvelope?.008:.025)));waveThickness=clamp(1.65+waveEnvelope*(.9*bassBody+2.45*kickEnvelope),1.5,5);
  }
  function updateStatus(){const lyrics=state.lyrics;status=!state.track?'waiting':hasWave?(audioConnected()?'audio-live':config.nativeAudio?'spotify-audio-connecting':captureFailed?'audio-unavailable':'audio-connecting'):(lyrics?.lines?.length?(lyrics.synced?'lyrics-synced':'lyrics-estimated'):!lyrics||lyrics.pending?'lyrics-loading':lyrics.instrumental?'instrumental':'lyrics-unavailable')}
  async function startAudio(){
    if(config.nativeAudio){$('audio-button').textContent='Reconnect Spotify audio';return window.stage?.reconnectAudio?.()}
    if(capturePending)return;capturePending=true;captureAttempts++;
    try{
      if(captureStream){captureStream.getTracks().forEach(t=>t.stop());captureStream=null}
      captureStream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
      if(!captureStream.getAudioTracks().length)throw new Error('Loopback audio unavailable');
      // Chromium needs a live screen track for loopback; it is never displayed
      // or recorded. Keep it tiny and one frame per second to avoid 4K capture work.
      for(const track of captureStream.getVideoTracks())try{await track.applyConstraints({width:{ideal:16},height:{ideal:16},frameRate:{max:1}})}catch{}
      // Keep its video track alive: Chromium may terminate loopback when the screen track ends.
      audioContext??=new AudioContext({latencyHint:'interactive'});await audioContext.resume();
      analyser=audioContext.createAnalyser();analyser.fftSize=2048;analyser.smoothingTimeConstant=.72;
      audioContext.createMediaStreamSource(captureStream).connect(analyser);captureFailed=false;
      captureStream.getAudioTracks()[0].onended=()=>{analyser=null;captureFailed=true;updateStatus()};
      $('audio-button').textContent='Reconnect audio';
    }catch(err){captureFailed=true;console.warn('FLOAT audio:',err.message)}
    finally{capturePending=false;updateStatus()}
  }
  function sampleAudio(dt){
    const fresh=!config.nativeAudio||!!testAudio||((testNow??performance.now())-lastAudioAt<100&&!!state.audio?.connected);
    if(role==='lyrics'&&state.audio){const playing=fresh&&(!config.nativeAudio?state.isPlaying:Number(state.audio.musicRms)>MUSIC_SILENCE_FLOOR);waveSoundActive=!!playing;const power=playing?Number(state.audio.rms||0):0,k=1-Math.exp(-dt/(power>rms?.012:.055));rms=lerp(rms,power,k);bass=lerp(bass,playing?Number(state.audio.bass||0):0,k);treble=lerp(treble,playing?Number(state.audio.treble||0):0,k);waveEnvelope=lerp(waveEnvelope,playing?clamp(Math.pow(Math.max(0,power)/.38,.7),0,1):0,k);return}
    let power=0,low=0,high=0;
    if(testAudio){timeData=testAudio.wave;frequencyData=testAudio.fft}
    else if(config.nativeAudio){const audio=state.audio;if(fresh&&audio?.wave?.length===timeData.length){timeData.set(audio.wave);if(audio.fft?.length===frequencyData.length)frequencyData.set(audio.fft);else frequencyData.fill(0)}else{timeData.fill(128);frequencyData.fill(0)}}
    else if(analyser&&state.isPlaying){analyser.getByteTimeDomainData(timeData);analyser.getByteFrequencyData(frequencyData)}
    else{timeData.fill(128);frequencyData.fill(0)}
    if(state.isPlaying||config.nativeAudio||testAudio){for(let i=0;i<timeData.length;i+=4){const v=(timeData[i]-128)/128;power+=v*v}power=Math.sqrt(power/(timeData.length/4));for(let i=2;i<22;i++)low+=frequencyData[i]/255;for(let i=70;i<180;i++)high+=frequencyData[i]/255;low/=20;high/=110}
    if(config.nativeAudio&&!testAudio&&fresh){const a=state.audio;if(Number.isFinite(a.rms))power=a.rms;if(Number.isFinite(a.bass))low=a.bass;if(Number.isFinite(a.treble))high=a.treble}
    waveSoundActive=!!state.track&&fresh&&(audioConnected()||!!testAudio)&&(config.nativeAudio&&!testAudio?Number(state.audio?.musicRms)>MUSIC_SILENCE_FLOOR:!!state.isPlaying&&power>1e-7);
    if(!waveSoundActive){
      // Stop sampling/moving the old shape immediately, but let its visible
      // amplitude settle. No invented oscillation and no one-frame reset.
      const fade=Math.exp(-dt/.055);waveEnvelope*=fade;rms*=fade;bass*=fade;treble*=fade;targetWave.set(displayWave);fromWave.set(displayWave);waveVelocity.fill(0);fromVelocity.fill(0);waveMorphAge=morphDuration;waveHash=null;if(waveEnvelope<.001)resetWaveState();return;
    }
    const k=1-Math.exp(-dt/(power>rms?.012:.055));rms=lerp(rms,power,k);bass=lerp(bass,low,k);treble=lerp(treble,high,k);
    const level=clamp(Math.pow(Math.max(0,power)/.38,.7),0,1);waveEnvelope=lerp(waveEnvelope,level,1-Math.exp(-dt/(level>waveEnvelope?.016:.055)));
    waveGain=config.nativeAudio&&state.audio?.normalized?1:state.isPlaying&&(audioConnected()||testAudio)?clamp(.12/Math.max(.025,power),1,5):1;
    // Proper anti-alias filtering before2048→33decimation; musical spikes are
    // never rejected. Phase-stable geometry is critically damped independently
    // of the fast music envelope. Beat accents do not wait for the shape filter.
    let hashValue=2166136261;for(let j=0;j<timeData.length;j++)hashValue=Math.imul(hashValue^timeData[j],16777619);
    if(hashValue!==waveHash){
      for(let i=0;i<33;i++){const kernel=waveKernel[i];let sum=0;for(let k=0;k<kernel.indices.length;k++)sum+=(timeData[kernel.indices[k]]-128)/128*kernel.weights[k];filteredWave[i]=sum}
      const alignment=alignedWaveShift(displayWave,filteredWave);wavePhaseShift=alignment.shift;wavePhaseCorrelation=alignment.correlation;
      fromWave.set(displayWave);fromVelocity.set(waveVelocity);for(let i=0;i<33;i++)targetWave[i]=filteredWave[(i+alignment.shift+33)%33];waveMorphAge=0;waveHash=hashValue;
    }
    waveMorphAge=Math.min(morphDuration,waveMorphAge+dt);const omega=90,decay=Math.exp(-omega*dt);
    for(let i=0;i<33;i++){const previous=displayWave[i],error=previous-targetWave[i],term=waveVelocity[i]+omega*error,candidate=targetWave[i]+(error+term*dt)*decay,nextVelocity=(waveVelocity[i]-omega*term*dt)*decay,bound=MAX_WAVE_SPEED*dt;displayWave[i]=clamp(previous+clamp(candidate-previous,-bound,bound),-1,1);waveVelocity[i]=clamp(nextVelocity,-MAX_WAVE_SPEED,MAX_WAVE_SPEED)}
  }
  function cloud(x,y,r,idx,alpha){
    const hue=Math.round(palette[idx%3]/5)*5,key=hue;let surface=cloudSprites.get(key);
    if(!surface){surface=document.createElement('canvas');surface.width=768;surface.height=768;const sc=rasterContext(surface),g=sc.createRadialGradient(384,384,0,384,384,384);g.addColorStop(0,`hsla(${hue},78%,55%,1)`);g.addColorStop(.48,`hsla(${hue},75%,40%,.36)`);g.addColorStop(1,`hsla(${hue},75%,40%,0)`);sc.fillStyle=g;sc.fillRect(0,0,768,768);if(cloudSprites.size>12)cloudSprites.delete(cloudSprites.keys().next().value);cloudSprites.set(key,surface)}
    ctx.save();ctx.globalAlpha=alpha;ctx.drawImage(surface,x-r,y-r,r*2,r*2);ctx.restore();
  }
  function background(t){
    const rasterKey=`${Math.round(palette[0]*4)}:${Math.round(palette[1]*4)}:${canvas.height}`;
    if(rasterKey!==oceanRasterKey){
      oceanRaster??=document.createElement('canvas');oceanRaster.width=1;oceanRaster.height=canvas.height;
      const sc=rasterContext(oceanRaster,false),ocean=sc.createLinearGradient(0,0,0,canvas.height);ocean.addColorStop(0,`hsl(${palette[0]},66%,75%)`);ocean.addColorStop(.18,`hsl(${palette[0]},67%,52%)`);ocean.addColorStop(.53,`hsl(${palette[1]},72%,35%)`);ocean.addColorStop(1,`hsl(${palette[1]},69%,20%)`);sc.fillStyle=ocean;sc.fillRect(0,0,1,canvas.height);oceanRasterKey=rasterKey;
    }
    ctx.drawImage(oceanRaster,0,0,width,height);
    const base=Math.min(width,height);
    ctx.save();ctx.globalCompositeOperation='screen';
    // Volumetric sunlight is rendered exclusively by the underwater GPU pass.
    // Moving surface caustics also exist in SDR; HDR adds only light headroom.
    if(!window.StageHDR?.stats?.().ready){
      const causticAlpha=.035+bass*.018;ctx.lineWidth=1.2;
      const columns=8,rows=8,cellX=width/columns,cellY=height*.75/rows;
      const waterPoint=(col,row)=>{const seed=col*31+row*17;return {x:(col+Math.sin(seed)*.19+Math.sin(t*.11+seed)*.09)*cellX,y:(row+Math.sin(seed+7)*.17+Math.cos(t*.14+seed)*.09)*cellY}};
      for(let row=0;row<rows;row++)for(let col=0;col<columns;col++){const p=waterPoint(col,row),a=waterPoint(col+1,row),b=waterPoint(col,row+1);ctx.strokeStyle=`rgba(231,255,252,${causticAlpha*.46*(1-row/rows)})`;ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.quadraticCurveTo((p.x+a.x)/2,(p.y+a.y)/2+Math.sin(t*.15+row+col)*cellY*.12,a.x,a.y);ctx.moveTo(p.x,p.y);ctx.quadraticCurveTo((p.x+b.x)/2+Math.cos(t*.13+row-col)*cellX*.10,(p.y+b.y)/2,b.x,b.y);ctx.stroke()}
    }
    ctx.restore();
    bubbles(t);
    if(pointerEnergy>.01)cloud(pointer.x,pointer.y,base*.16,0,pointerEnergy*.08);
  }
  function bubbleSprite(index,radius,r2){
    let sprite=bubbleSprites.get(index);if(sprite)return sprite;
    const pad=3,size=(radius+pad)*2,surface=document.createElement('canvas');surface.width=Math.ceil(size*renderScale);surface.height=Math.ceil(size*scaleY);const sc=rasterContext(surface);sc.setTransform(renderScale,0,0,scaleY,0,0);sc.translate(radius+pad,radius+pad);
    const alpha=.12+r2*.12,glass=sc.createRadialGradient(-radius*.06,-radius*.04,0,0,0,radius);
    glass.addColorStop(0,'rgba(225,255,255,.008)');glass.addColorStop(.68,'rgba(215,253,255,.012)');glass.addColorStop(.86,`rgba(218,252,255,${alpha*.24})`);glass.addColorStop(.95,`rgba(235,255,255,${alpha*.70})`);glass.addColorStop(1,'rgba(227,255,255,0)');sc.fillStyle=glass;sc.beginPath();sc.arc(0,0,radius,0,Math.PI*2);sc.fill();
    // Air/water Fresnel reflection fades through the sphere rim; it has no
    // cartoon outline. Two restrained glints retain the transmitted glass look.
    const glint=sc.createRadialGradient(-radius*.39,-radius*.48,0,-radius*.39,-radius*.48,Math.max(.45,radius*.23));glint.addColorStop(0,`rgba(252,255,255,${alpha*1.9})`);glint.addColorStop(.28,`rgba(240,255,255,${alpha*.55})`);glint.addColorStop(1,'rgba(242,255,255,0)');sc.fillStyle=glint;sc.fillRect(-radius,-radius,radius*2,radius*2);
    const transmitted=sc.createRadialGradient(radius*.32,radius*.46,0,radius*.32,radius*.46,Math.max(.35,radius*.18));transmitted.addColorStop(0,`rgba(194,249,255,${alpha*.45})`);transmitted.addColorStop(1,'rgba(209,255,255,0)');sc.fillStyle=transmitted;sc.fillRect(-radius,-radius,radius*2,radius*2);sprite={surface,size};bubbleSprites.set(index,sprite);return sprite;
  }
  function spawnBubble(p,x,y,large=false,initial=false){
    const seed=++fluidSerial*37.913,r=random(seed),r2=random(seed+1),depth=random(seed+2);
    Object.assign(p,{alive:true,x:x+(random(seed+3)-.5)*(large?18:35),y:y+(random(seed+4)-.5)*(large?12:26),vx:(random(seed+5)-.5)*8,vy:-4-r*8,radius:large?6+r*13:1+r*3.1,depth,age:0,life:large?12+r2*23:.75+r2*1.8,large,seed,shine:r2});
    if(initial)p.age=random(seed+6)*p.life*.42;
    bubbleSprites.delete(p.index);
  }
  function stepFluid(dt,t){
    if(!fluidInitialized){for(let i=0;i<12;i++)spawnBubble(fluidParticles[i],width*(.08+random(i+48)*.84),height*(.23+random(i+94)*.73),i<4,true);fluidInitialized=true}
    const base=Math.min(width,height);
    for(const p of fluidParticles){if(!p.alive)continue;p.age+=dt;if(p.age>=p.life||p.y<-p.radius*3||p.y>height+p.radius*3||p.x<-p.radius*3||p.x>width+p.radius*3){p.alive=false;continue}
      const localFlow=water.sample(p.x,p.y),flowX=(Math.sin(t*.14+p.depth*4)*.006+Math.sin(p.y/height*4+t*.09)*.0025)*base+localFlow.x;
      const rise=base*(.010+.026*Math.sqrt(p.radius/19))*(.65+p.depth*.45)*musicMotionSpeed,drag=p.large?1.65:2.8,k=1-Math.exp(-dt*drag);
      p.vx=lerp(p.vx,flowX,k);p.vy=lerp(p.vy,localFlow.y-rise,k);p.x+=p.vx*dt;p.y+=p.vy*dt;
    }
    nextBubbleBurst-=dt;if(nextBubbleBurst<=0){
      const energy=clamp(bass*.75+rms*1.8,0,1),seed=fluidSerial+731,x=width*(.07+random(seed)*.86),y=height*(.17+random(seed+1)*.76),births=3+Math.floor(random(seed+2)*4+energy*3);
      let largeCount=fluidParticles.reduce((n,p)=>n+(p.alive&&p.large?1:0),0),born=0;
      for(const p of fluidParticles){if(p.alive)continue;const large=largeCount<6&&random(fluidSerial+13)>.9;spawnBubble(p,large?width*(.1+random(fluidSerial+15)*.8):x,large?height*(.87+random(fluidSerial+17)*.12):y,large);if(large)largeCount++;if(++born>=births)break}
      nextBubbleBurst=(.45+random(fluidSerial+39)*.95)*(1-energy*.64);
    }
    vortexBirthCooldown-=dt;if(vortexBirthCooldown<=0&&water.maxCurl>.65){let born=0;for(const p of fluidParticles){if(p.alive)continue;spawnBubble(p,water.hotX,water.hotY,false);if(++born>=2)break}vortexBirthCooldown=.8+random(fluidSerial+323)*1.2}
  }
  function bubbles(t){
    for(const p of fluidParticles){if(!p.alive)continue;const phase=p.age/p.life,intro=smooth(p.age/.13),dissolve=p.large?smooth((1-phase)/.16):smooth((1-phase)/.50),shrink=p.large?lerp(.8,1,intro):lerp(.18,1,dissolve),activity=intro*dissolve;if(activity<.005)continue;
      const sprite=bubbleSprite(p.index,p.radius,p.shine),wobble=Math.sin(t*.43+p.depth*5)*.014;
      ctx.save();ctx.globalAlpha=activity;ctx.translate(p.x,p.y);ctx.scale(shrink*(1+wobble),shrink*(1-wobble));ctx.drawImage(sprite.surface,-sprite.size/2,-sprite.size/2,sprite.size,sprite.size);ctx.restore();
    }
  }
  function glyphLayout(line,index,owner=previousId,script=cueScript(line)){
    if(!ensureFonts(familiesFor(line,script)))return null;
    const key=`${owner}:${index}:${script}:${line.text}`;if(layoutCache.has(key))return layoutCache.get(key);
    const maxW=width*.79, baseSize=clamp(width*.067,26,200), chars=Array.from(line.text||'');
    let fontSize=baseSize;if(chars.length<12)fontSize*=1.11;
    const rows=[];let row=[],rowW=0;
    // Wrap at spaces when possible; CJK can wrap at each character.
    for(let j=0;j<chars.length;j++){const ch=chars[j],family=glyphFamily(ch,script);ctx.font=fontCSS(family,fontSize);const cw=ctx.measureText(ch).width+fontSize*.011;
      if(rowW+cw>maxW&&row.length){let breakAt=-1;for(let k=row.length-1;k>Math.floor(row.length*.55);k--)if(row[k].ch===' '){breakAt=k;break}
        if(breakAt>0){const tail=row.splice(breakAt+1);row.pop();rows.push(row);row=tail;rowW=row.reduce((s,c)=>s+c.w,0)}else{rows.push(row);row=[];rowW=0}}
      if(!row.length&&ch===' ')continue;row.push({ch,family,w:cw,ordinal:j});rowW+=cw;
    }
    if(row.length)rows.push(row);if(rows.length>1&&rows.at(-1).length===1&&rows.at(-2).length>4){const moved=rows.at(-2).splice(-2);while(moved[0]?.ch===' ')moved.shift();rows[rows.length-1]=moved.concat(rows.at(-1))}const result=[];let k=0;
    rows.forEach((r,ri)=>{const rw=r.reduce((s,c)=>s+c.w,0);let x=(width-rw)/2;r.forEach(c=>{result.push({...c,x:x+c.w/2,y:(ri-(rows.length-1)/2)*fontSize*1.45,seed:hash(`${owner}:${index}:${k++}`)});x+=c.w})});
    const item={glyphs:result,fontSize,height:rows.length*fontSize*1.45};layoutCache.set(key,item);return item;
  }
  function cueIndex(lines,pos){let lo=0,hi=lines.length-1,ans=-1;while(lo<=hi){let mid=(lo+hi)>>1;if(Number(lines[mid].time)<=pos){ans=mid;lo=mid+1}else hi=mid-1}return ans}
  function glyphSprite(ch,size,idx,active,family='OAGothic'){
    const hue=Math.round(palette[idx%3]/15)*15,key=`${family}:${ch}:${size}:${active?'white-'+hue:hue}`;let sprite=sprites.get(key);if(sprite)return sprite;
    const metrics=ctx.measureText(ch),pad=active?20:16,left=Math.ceil(Math.max(0,metrics.actualBoundingBoxLeft??size*.55)),right=Math.ceil(Math.max(0,metrics.actualBoundingBoxRight??size*.55)),top=Math.ceil(Math.max(0,metrics.actualBoundingBoxAscent??size*.55)),bottom=Math.ceil(Math.max(0,metrics.actualBoundingBoxDescent??size*.55)),w=Math.max(1,left+right+pad*2),h=Math.max(1,top+bottom+pad*2),surface=document.createElement('canvas');surface.width=Math.ceil(w*renderScale);surface.height=Math.ceil(h*scaleY);const sc=rasterContext(surface);sc.setTransform(renderScale,0,0,scaleY,0,0);sc.font=fontCSS(family,size);sc.textAlign='center';sc.textBaseline='middle';sc.shadowColor=`hsla(${hue},75%,74%,.6)`;sc.shadowBlur=(active?15:12)*renderScale;sc.fillStyle=active?'#f4fcfa':`hsl(${hue},31%,84%)`;sc.fillText(ch,left+pad,top+pad);sprite={surface,w,h,x:-left-pad,y:-top-pad,inkWidth:left+right,inkHeight:top+bottom,inkCenterX:(right-left)*.5,inkCenterY:(bottom-top)*.5,family};if(sprites.size>240)sprites.delete(sprites.keys().next().value);sprites.set(key,sprite);return sprite;
  }
  let collisionMetrics={checks:0,contacts:0,candidates:0};
  function newBody(id){return {ox:0,oy:0,vx:0,vy:0,angle:0,av:0,pitchOffset:0,yawOffset:0,pitchV:0,yawV:0,pitchTarget:0,yawTarget:0,lastSeen:motionTime,seed:hash(id)%97,collisionActive:false,collisionUntil:0}}
  function bodyFor(id){if(!physics.has(id))physics.set(id,newBody(id));return physics.get(id)}
  function solveContacts(glyphs,bodies,held=null,progress=1){
    const records=[],buckets=new Map(),seen=new Set(),cell=clamp(width*.067,40,120);let checks=0,contacts=0;
    for(const g of glyphs){if(records.length>=384)break;if(g.opacity<.045||g.radius<3)continue;const b=bodies.get(g.id),fraction=g.id===held?progress:1,x=g.centerX+((b?.ox||0)-(g.bodyOx||0))*fraction,y=g.centerY+((b?.oy||0)-(g.bodyOy||0))*fraction;
      const r={g,x,y,sx:g.previousX??g.centerX,sy:g.previousY??g.centerY,radius:g.radius,index:records.length};records.push(r);const minX=Math.floor((Math.min(r.x,r.sx)-r.radius)/cell),maxX=Math.floor((Math.max(r.x,r.sx)+r.radius)/cell),minY=Math.floor((Math.min(r.y,r.sy)-r.radius)/cell),maxY=Math.floor((Math.max(r.y,r.sy)+r.radius)/cell);
      for(let cy=minY;cy<=maxY;cy++)for(let cx=minX;cx<=maxX;cx++){const key=(cx+1024)*2048+cy+1024;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(r)}
    }
    outer:for(const bucket of buckets.values())for(let i=0;i<bucket.length;i++){
      const a=bucket[i],ag=a.g;
      for(let j=0;j<bucket.length;j++){if(i===j)continue;const b=bucket[j],bg=b.g;let ab=bodies.get(ag.id),bb=bodies.get(bg.id);const key=Math.min(a.index,b.index)*384+Math.max(a.index,b.index);if(seen.has(key))continue;seen.add(key);if(++checks>1500)break outer;
      let dx=b.x-a.x,dy=b.y-a.y,distance=Math.hypot(dx,dy),radius=a.radius+b.radius,penetration=radius-distance;
      const endNX=distance>.001?dx/distance:1,endNY=distance>.001?dy/distance:0,rx=b.sx-a.sx,ry=b.sy-a.sy,tx=(b.x-b.sx)-(a.x-a.sx),ty=(b.y-b.sy)-(a.y-a.sy),den=tx*tx+ty*ty,startSq=rx*rx+ry*ry;let swept=false;
      if(den>1e-6&&startSq>=radius*radius){const dot=rx*tx+ry*ty,discriminant=dot*dot-den*(startSq-radius*radius);if(discriminant>=0){const enter=(-dot-Math.sqrt(discriminant))/den;if(enter>=0&&enter<=1){dx=rx+tx*enter;dy=ry+ty*enter;distance=Math.hypot(dx,dy);swept=true}}}
      if(penetration<0&&!swept)continue;
      if(distance<.001){dx=1;dy=0;distance=1}const nx=dx/distance,ny=dy/distance;
      ab??=newBody(ag.id);bb??=newBody(bg.id);bodies.set(ag.id,ab);bodies.set(bg.id,bb);ab.collisionActive=bb.collisionActive=true;ab.collisionUntil=bb.collisionUntil=motionTime+8;
      const massA=Math.max(.35,ag.area/1800),massB=Math.max(.35,bg.area/1800),invA=ag.id===held?0:1/massA,invB=bg.id===held?0:1/massB,inv=invA+invB;if(!inv)continue;
      const avx=ag.id===held?pointer.vx:ab.vx,avy=ag.id===held?pointer.vy:ab.vy,bvx=bg.id===held?pointer.vx:bb.vx,bvy=bg.id===held?pointer.vy:bb.vy,relativeX=bvx-avx,relativeY=bvy-avy,normalSpeed=relativeX*nx+relativeY*ny;
      const inertiaA=Math.max(1,massA*(ag.inkWidth**2+ag.inkHeight**2)/12),inertiaB=Math.max(1,massB*(bg.inkWidth**2+bg.inkHeight**2)/12);
      if(normalSpeed<0){const impulse=-(1+.18)*normalSpeed/inv,tx=-ny,ty=nx,tangentSpeed=relativeX*tx+relativeY*ty+(bb.av||0)*b.radius+(ab.av||0)*a.radius,jt=clamp(-tangentSpeed/inv,-impulse*.16,impulse*.16),jx=impulse*nx+jt*tx,jy=impulse*ny+jt*ty;
        ab.vx-=jx*invA;ab.vy-=jy*invA;bb.vx+=jx*invB;bb.vy+=jy*invB;
        if(invA)ab.av=clamp(ab.av+(-jt*a.radius+impulse*((ag.centerY-ag.y)*nx-(ag.centerX-ag.x)*ny))/inertiaA,-3.5,3.5);
        if(invB)bb.av=clamp(bb.av+(-jt*b.radius-impulse*((bg.centerY-bg.y)*nx-(bg.centerX-bg.x)*ny))/inertiaB,-3.5,3.5);
        if(invA){ab.pitchTarget=clamp(ab.pitchTarget-jy*invA*.001,-.8,.8);ab.yawTarget=clamp(ab.yawTarget+jx*invA*.001,-.8,.8)}
        if(invB){bb.pitchTarget=clamp(bb.pitchTarget+jy*invB*.001,-.8,.8);bb.yawTarget=clamp(bb.yawTarget-jx*invB*.001,-.8,.8)}
      }
      const correction=Math.min(3,Math.max(0,penetration-.5)*.28)/inv;ab.ox-=endNX*correction*invA;ab.oy-=endNY*correction*invA;bb.ox+=endNX*correction*invB;bb.oy+=endNY*correction*invB;contacts++;
      }
    }
    for(const r of records){r.g.previousX=r.x;r.g.previousY=r.y}
    return {checks:Math.min(checks,1500),contacts,candidates:records.length};
  }
  function stepPhysics(dt){
    pointerEnergy*=Math.exp(-dt*1.7);
    let collidable=0;for(const g of hitGlyphs){if(g.opacity<.045||g.radius<3)continue;const b=bodyFor(g.id);b.screenX=g.x;b.screenY=g.y;b.radius=g.radius;collidable++}
    const hasCollisions=collidable>1;
    const substeps=hasCollisions?2:1,step=dt/substeps;collisionMetrics={checks:0,contacts:0,candidates:0};
    for(let sub=0;sub<substeps;sub++){
      for(const [id,b]of physics){if(id===dragged)continue;const flow=water.sample(b.screenX??width*.5,b.screenY??height*.5),flowX=flow.x+Math.sin(motionTime*.14+(b.seed||0))*.9;b.vx=lerp(b.vx,flowX,1-Math.exp(-step*.4));b.vy=lerp(b.vy,flow.y-.65,1-Math.exp(-step*.35));if(hasCollisions){const speed=Math.hypot(b.vx,b.vy),limit=Math.min(1400,Math.max(120,(b.radius||24)*1.05/Math.max(.004,step)));if(speed>limit){b.vx*=limit/speed;b.vy*=limit/speed}}b.ox+=b.vx*step;b.oy+=b.vy*step;b.angle+=b.av*step;b.av*=Math.exp(-step*.9);const angularBlend=1-Math.exp(-step*.4);b.pitchV=lerp(b.pitchV,b.pitchTarget+flow.y*.0004,angularBlend);b.yawV=lerp(b.yawV,b.yawTarget+flow.x*.0004,angularBlend);b.pitchOffset+=b.pitchV*step;b.yawOffset+=b.yawV*step;b.pitchTarget*=Math.exp(-step*.35);b.yawTarget*=Math.exp(-step*.35);if(motionTime-b.lastSeen>30)physics.delete(id)}
      if(hasCollisions){const result=solveContacts(hitGlyphs,physics,dragged,(sub+1)/substeps);collisionMetrics.checks+=result.checks;collisionMetrics.contacts+=result.contacts;collisionMetrics.candidates=Math.max(collisionMetrics.candidates,result.candidates)}
    }
  }
  function lyrics(t,pos){
    const lines=state.lyrics?.lines||[],idx=lines.length?cueIndex(lines,pos):-1;
    const hint=trackScript(),birth=i=>{if(!lines[i]?.text?.trim())return;const key=`${currentCohort}::${i}`;liveCues.add(i);if(!cueEntities.has(key))cueEntities.set(key,{key,cohort:currentCohort,owner:previousId,index:i,line:{...lines[i]},script:cueScript(lines[i],hint),birth:t-Math.max(0,(pos-Number(lines[i].time))/1000),orphanedAt:null,layout:null})};
    if(idx>=0){if(lastCue<0){let start=idx;while(start>0&&pos-Number(lines[start-1].time)<30000)start--;for(let i=start;i<=idx;i++)birth(i)}else for(let i=lastCue+1;i<=idx;i++)birth(i);lastCue=idx}
    ctx.save();textMaskCtx?.save();const shake=(.3+rms*1.9),cameraX=Math.sin(t*1.9)*shake,cameraY=Math.cos(t*2.3)*shake;ctx.translate(cameraX,cameraY);textMaskCtx?.translate(cameraX,cameraY);
    renderedGlyphs=0;
    for(const [key,entity]of cueEntities){
      const age=Math.max(0,t-entity.birth),velocity=height*.057,fade=(1-smooth((age-12)/16))*(entity.orphanedAt===null?1:1-smooth((t-entity.orphanedAt)/7));if(fade<=.0001){cueEntities.delete(key);if(entity.cohort===currentCohort)liveCues.delete(entity.index);for(const id of physics.keys())if(id.startsWith(key+'::')){physics.delete(id);if(dragged===id){dragged=null;document.body.classList.remove('dragging')}}continue}
      const item=entity.layout??=glyphLayout(entity.line,entity.index,entity.owner,entity.script);if(!item)continue;const birthY=height+item.height*.5-item.fontSize*.3;ctx.textAlign='center';ctx.textBaseline='middle';
      for(let j=0;j<item.glyphs.length;j++){
        const g=item.glyphs[j];if(/^\s$/u.test(g.ch))continue;ctx.font=fontCSS(g.family,item.fontSize);
        const r=random(g.seed),r2=random(g.seed+1),r3=random(g.seed+2);
        const drift=(r-.5)*age*(2.0+age*.12)+Math.sin(age*.32+r2*12)*age*.6;
        const anchorX=g.x+drift,anchorY=birthY+g.y-velocity*age*(1+(r3-.5)*.055)+Math.sin(t*.8+r*10)*Math.min(2,age*.1);
        const id=`${key}::${j}`;let b=physics.get(id);if(b){b.lastSeen=motionTime;if(id===dragged){b.ox=pointer.x-anchorX;b.oy=pointer.y-anchorY}}
        const x=anchorX+(b?.ox||0),y=anchorY+(b?.oy||0);
        if(y<-item.fontSize||y>height+item.fontSize||x<-item.fontSize||x>width+item.fontSize)continue;
        const depth=1-Math.min(.14,age*.005*r2),pitch=(random(g.seed+4)-.5)*.20+(r3-.5)*age*.10+(b?.pitchOffset||0),yaw=(random(g.seed+5)-.5)*.23+(r-.5)*age*.12+(b?.yawOffset||0),angle=(r-.5)*age*.06+Math.sin(age*.31+r2*10)*age*.006+(b?.angle||0),cos=Math.cos(angle),sin=Math.sin(angle),cyaw=Math.cos(yaw),cpitch=Math.cos(pitch),shear=Math.sin(yaw)*Math.sin(pitch);
        const xx=cos*cyaw*depth,yx=sin*cyaw*depth,xy=(cos*shear-sin*cpitch)*depth,yy=(sin*shear+cos*cpitch)*depth,sprite=glyphSprite(g.ch,item.fontSize,g.seed%3,true,g.family),centerX=x+xx*sprite.inkCenterX+xy*sprite.inkCenterY+cameraX,centerY=y+yx*sprite.inkCenterX+yy*sprite.inkCenterY+cameraY,opacity=glyphAlpha(centerY,fade);ctx.save();ctx.globalAlpha=opacity;ctx.translate(x,y);ctx.transform(xx,yx,xy,yy,0,0);
        ctx.drawImage(sprite.surface,sprite.x,sprite.y,sprite.w,sprite.h);ctx.restore();
        if(textMaskCtx){textMaskCtx.save();textMaskCtx.globalAlpha=lightMaskAlpha(age,entity.orphanedAt===null?null:t-entity.orphanedAt);textMaskCtx.translate(x,y);textMaskCtx.transform(xx,yx,xy,yy,0,0);textMaskCtx.drawImage(sprite.surface,sprite.x,sprite.y,sprite.w,sprite.h);textMaskCtx.restore()}
        if(b){b.screenX=x;b.screenY=y}
        const inkWidth=sprite.inkWidth*Math.hypot(xx,yx),inkHeight=sprite.inkHeight*Math.hypot(xy,yy),area=Math.max(1,sprite.inkWidth*sprite.inkHeight*Math.abs(xx*yy-xy*yx)),halfWidth=(Math.abs(xx)*sprite.inkWidth+Math.abs(xy)*sprite.inkHeight)/2,halfHeight=(Math.abs(yx)*sprite.inkWidth+Math.abs(yy)*sprite.inkHeight)/2;
        if(opacity>=.045&&.43*Math.sqrt(area)>=3){b??=bodyFor(id);b.screenX=x;b.screenY=y;b.radius=.43*Math.sqrt(area)}
        hitGlyphs.push({id,ch:g.ch,family:g.family,x,y,anchorX,anchorY,size:item.fontSize,w:g.w,centerX,centerY,inkWidth,inkHeight,halfWidth,halfHeight,area,radius:.43*Math.sqrt(area),angle,pitch,yaw,opacity,bodyOx:b?.ox||0,bodyOy:b?.oy||0});renderedGlyphs++;
      }
    }
    ctx.restore();textMaskCtx?.restore();
  }
  function wavePath(amplitude,phase,offsetY,draw=ctx){
    const count=displayWave.length-1;let lastX=width*.055,lastY=wavePoint(0,amplitude)+offsetY;draw.beginPath();draw.moveTo(lastX,lastY);for(let i=1;i<=count;i++){const x=width*(.055+i/count*.89),y=wavePoint(i,amplitude)+offsetY;draw.quadraticCurveTo(lastX,lastY,(lastX+x)/2,(lastY+y)/2);lastX=x;lastY=y}draw.lineTo(lastX,lastY);
  }
  function wavePoint(index,amplitude){const value=displayWave[index]*.92+(displayWave[Math.max(0,index-1)]+displayWave[Math.min(32,index+1)])*.04;return height*.49+value*amplitude*Math.sin(index/(displayWave.length-1)*Math.PI)**2}
  function waveAmplitude(){return height*.192*waveGain*waveEnvelope*(.55+.30*bassBody+.20*kickEnvelope)}
  function waveHeightAt(f,amplitude){const count=displayWave.length-1,c=clamp(f,0,1)*count;if(c<.5)return lerp(wavePoint(0,amplitude),wavePoint(1,amplitude),c);if(c>count-.5)return lerp(wavePoint(count-1,amplitude),wavePoint(count,amplitude),c-(count-1));const i=Math.floor(c+.5),u=c-i+.5,a=(wavePoint(i-1,amplitude)+wavePoint(i,amplitude))/2,b=wavePoint(i,amplitude),d=(wavePoint(i,amplitude)+wavePoint(i+1,amplitude))/2;return (1-u)**2*a+2*u*(1-u)*b+u*u*d}
  function waveGradient(alpha,index,progress=null,draw=ctx){
    const cacheKey=progress===null?`${draw===ctx?'base':'mask'}:${alpha}:${index}:${palette.map(h=>Math.round(h*2)).join(':')}`:null;if(cacheKey&&waveGradients.has(cacheKey))return waveGradients.get(cacheKey);
    const gradient=draw.createLinearGradient(width*.055,0,width*.945,0),stops=[0,.02,.04,.07,.10,.12,.24,.36,.5,.65,.76,.88,.9,.93,.96,.98,1];
    if(progress!==null)stops.push(clamp(progress-.006,0,1),clamp(progress,0,1),clamp(progress+.006,0,1));
    stops.sort((a,b)=>a-b);
    for(const f of stops){const edge=smooth(f/.12)*smooth((1-f)/.12),consumed=progress===null?1:1-smooth((f-progress+.006)/.012);const hue=lerp(palette[index%3],palette[(index+1)%3],f);gradient.addColorStop(f,`hsla(${hue},66%,92%,${alpha*edge*consumed})`)}
    if(cacheKey){if(waveGradients.size>24)waveGradients.delete(waveGradients.keys().next().value);waveGradients.set(cacheKey,gradient)}return gradient;
  }
  function waveform(t){
    const centerX=width*.5,centerY=height*.49,base=Math.min(width,height),energy=clamp(rms*3,0,1);
    ctx.save();ctx.globalCompositeOperation='screen';ctx.lineCap='round';ctx.lineJoin='round';
    const amplitude=waveAmplitude();
    wavePath(amplitude,0,0);ctx.shadowBlur=0;
    const timeline=timelineState(t),trackRatio=timeline.ratio,headX=width*(.055+trackRatio*.89);
    // The signal is also the timeline: consumed audio is luminous, future audio translucent.
    const coreWidth=waveThickness,progressWidth=Math.min(5,waveThickness+.18);
    ctx.strokeStyle=waveGradient(.62,0);ctx.lineWidth=coreWidth;ctx.stroke();
    ctx.strokeStyle=waveGradient(.97*timeline.opacity,0,trackRatio);ctx.lineWidth=progressWidth;ctx.stroke();
    ctx.restore();
    // Opaque core alpha protects legibility; the progressed section retains its
    // wider luminous footprint. The GPU owns its restrained radial wave light.
    waveMaskCtx.save();waveMaskCtx.globalAlpha=1;waveMaskCtx.lineCap='round';waveMaskCtx.lineJoin='round';wavePath(amplitude,0,0,waveMaskCtx);waveMaskCtx.strokeStyle=waveGradient(1,0,null,waveMaskCtx);waveMaskCtx.lineWidth=coreWidth;waveMaskCtx.stroke();waveMaskCtx.strokeStyle=waveGradient(.97*timeline.opacity,0,trackRatio,waveMaskCtx);waveMaskCtx.lineWidth=progressWidth;waveMaskCtx.stroke();waveMaskCtx.restore();
    if(state.track){
      const headY=waveHeightAt(trackRatio,amplitude);ctx.fillStyle=`rgba(255,255,255,${timeline.opacity})`;ctx.beginPath();ctx.arc(headX,headY,1.1,0,Math.PI*2);ctx.fill();
    }
  }
  function timelineState(t=motionTime){const target=clamp((position()-offset)/(state.track?.duration||1),0,1);if(!waveTransition){displayProgress=target;return {ratio:target,opacity:1}}const age=Math.max(0,t-waveTransition.start);if(age<.8){displayProgress=waveTransition.from;return {ratio:displayProgress,opacity:1-smooth(age/.8)}}displayProgress=target;if(age>=1.8){waveTransition=null;return {ratio:target,opacity:1}}return {ratio:target,opacity:smooth((age-.8)/1)}}
  function render(now){
    // Chromium can clock every window from the primary display. Pace drawing to
    // THIS monitor while retaining RAF VSync and integrating rendered-frame dt.
    const renderInterval=1000/Math.max(1,Number(config.refreshRate)||60);
    if(testNow===null&&frames>0&&now-lastFrame<renderInterval-.25){requestAnimationFrame(render);return}
    const begin=performance.now(),rawDt=(now-lastFrame)/1000,dt=clamp(rawDt,0,.08);lastFrame=now;
    if(testNow===null&&now-fpsWindowStart>=1000){fps=fpsWindowFrames*1000/(now-fpsWindowStart);fpsWindowFrames=0;fpsWindowStart=now}
    motionTime=testNow===null?(Date.now()-(config.timeOrigin||Date.now()-1000))/1000:(testMotion??position()/1000);
    const modes=[[194,211,178],[156,182,135],[32,195,18]],phase=((motionTime%240)+240)%240/80,mode=Math.floor(phase),transition=smooth(phase-mode);
    for(let i=0;i<3;i++){artOffsets[i]=lerp(artOffsets[i],desiredArtOffsets[i],1-Math.exp(-dt*.9));const from=modes[mode][i],to=modes[(mode+1)%3][i],delta=((to-from+540)%360)-180;desiredPalette[i]=(from+delta*transition+artOffsets[i]+360)%360}
    for(let i=0;i<3;i++){let delta=((desiredPalette[i]-palette[i]+540)%360)-180;palette[i]=(palette[i]+delta*(1-Math.exp(-dt*.8))+360)%360}
    if(frames%12===0)document.documentElement.style.setProperty('--accent',color(0,1,78,68));sampleAudio(dt);stepBassBeat(dt);const musicPlaying=stepMusicMotion(dt);if(hasWave&&!config.nativeAudio&&now-lastAudioReportAt>50){lastAudioReportAt=now;window.stage?.reportAudio?.({rms,bass,treble})}water.update(dt);stepPhysics(dt);stepFluid(dt,motionTime);
    // Sample the newest music even when the GPU is busy. Avoid queuing old
    // pictures/canvas copies behind it: the next displayed frame uses NOW.
    if(window.StageHDR?.canUpdate?.()===false){if(Date.now()-lastReportAt>1000){lastReportAt=Date.now();window.stage?.report?.({...window.__stageTest.stats(),hdr:window.StageHDR?.stats?.()||null})}if(testNow===null)requestAnimationFrame(render);return}
    if(testNow===null)fpsWindowFrames++;hitGlyphs=[];background(motionTime);
    textMaskCtx.clearRect(0,0,width,height);if(waveMaskCanvas)waveMaskCtx.clearRect(0,0,width,height);const pos=position();if(hasLyrics)lyrics(motionTime,pos);if(hasWave)waveform(motionTime);
    window.StageHDR?.update?.({time:motionTime,rayMotionTime,musicMotionSpeed,isPlaying:musicPlaying,energy:clamp(rms*3+bass*.35,0,1),hues:palette,role,pointer:{x:pointer.x/width,y:pointer.y/height,xNormalized:pointer.x/width,yNormalized:pointer.y/height},pointerEnergy,textMaskCanvas,waveMaskCanvas});
    frames++;
    frameMs=lerp(frameMs,performance.now()-begin,.04);if(frames>240&&frameMs>1000/(config.refreshRate||60)*1.1&&quality===1)quality=.7;
    if(Date.now()-lastReportAt>1000){lastReportAt=Date.now();try{window.stage?.report?.({...window.__stageTest.stats(),hdr:window.StageHDR?.stats?.()||null})}catch{}}
    if(testNow===null)requestAnimationFrame(render);
  }
  function showHud(){document.body.classList.add('show-controls');$('hud').classList.remove('hidden');clearTimeout(hudTimer);hudTimer=setTimeout(()=>{document.body.classList.remove('show-controls');$('hud').classList.add('hidden')},3200)}
  function setOffset(n){offset=clamp(n,-10000,10000);$('offset-label').textContent=`Lyrics offset ${offset>=0?'+':''}${(offset/1000).toFixed(1)}s`;try{window.stage?.setOffset?.(offset)}catch{}showHud()}
  function control(action){try{window.stage?.control?.(action)}catch(err){console.warn(err)}}
  function hitAt(x,y){for(let i=hitGlyphs.length-1;i>=0;i--){const g=hitGlyphs[i];if(Math.abs(g.centerX-x)<Math.max(8,g.halfWidth+4)&&Math.abs(g.centerY-y)<Math.max(8,g.halfHeight+4))return g}return null}
  addEventListener('pointermove',e=>{
    const now=performance.now(),dt=clamp((now-pointer.at)/1000,.008,.12),dx=e.clientX-pointer.x,dy=e.clientY-pointer.y;
    pointer.vx=pointer.at?lerp(pointer.vx,clamp(dx/dt,-2400,2400),.6):0;pointer.vy=pointer.at?lerp(pointer.vy,clamp(dy/dt,-2400,2400),.6):0;pointer.x=e.clientX;pointer.y=e.clientY;pointer.at=now;
    const speed=Math.hypot(pointer.vx,pointer.vy);pointerEnergy=clamp(pointerEnergy+speed*.00006*FLOW_STRENGTH,0,1);
    if(speed>35)water.inject(pointer.x,pointer.y,pointer.vx,pointer.vy,Math.min(120,width*.14));
    if(dragged){const g=hitGlyphs.find(g=>g.id===dragged),b=bodyFor(dragged);if(g){b.ox=pointer.x-g.anchorX;b.oy=pointer.y-g.anchorY;b.vx=0;b.vy=0}}
  });
  function isWaveHit(x,y){if(!hasWave||x<width*.055||x>width*.945)return false;const ratio=clamp((x/width-.055)/.89,0,1);return Math.abs(y-waveHeightAt(ratio,waveAmplitude()))<=Math.max(8,waveThickness*1.5)}
  addEventListener('pointerdown',e=>{if(audioContext?.state==='suspended')audioContext.resume();if(e.target!==canvas||e.button!==0)return;const waveHit=role==='combined'?isWaveHit(e.clientX,e.clientY):hasWave&&Math.abs(e.clientY-height*.49)<height*.26;if(waveHit){seekTap={x:e.clientX,y:e.clientY};return}const g=hitAt(e.clientX,e.clientY);if(g){dragged=g.id;const b=bodyFor(g.id);b.collisionActive=true;b.collisionUntil=motionTime+8;canvas.setPointerCapture(e.pointerId);document.body.classList.add('dragging');e.preventDefault()}});
  function release(){if(dragged){const b=bodyFor(dragged);b.vx=pointer.vx*.65;b.vy=pointer.vy*.65;b.av=clamp(pointer.vx*.0007,-2,2);b.pitchTarget=clamp(-pointer.vy*.00014,-.45,.45);b.yawTarget=clamp(pointer.vx*.00014,-.45,.45);b.collisionActive=true;b.collisionUntil=motionTime+8;dragged=null;document.body.classList.remove('dragging')}}
  addEventListener('pointerup',e=>{if(seekTap){if(Math.hypot(e.clientX-seekTap.x,e.clientY-seekTap.y)<6&&state.track)control({type:'seek',ratio:clamp((e.clientX/width-.055)/.89,0,1)});seekTap=null}release()});addEventListener('pointercancel',()=>{seekTap=null;release()});addEventListener('blur',()=>{seekTap=null;release()});
  addEventListener('contextmenu',e=>{e.preventDefault();showHud()});
  addEventListener('keydown',e=>{if(e.code==='Escape')control('close');else if(e.code==='Space'){e.preventDefault();control('togglePlayback')}else if(e.code==='ArrowRight'){e.preventDefault();setOffset(offset+200)}else if(e.code==='ArrowLeft'){e.preventDefault();setOffset(offset-200)}else if(e.code==='KeyH')showHud()});
  $('offset-minus').onclick=()=>setOffset(offset-200);$('offset-plus').onclick=()=>setOffset(offset+200);$('audio-button').onclick=()=>{captureFailed=false;startAudio()};$('close-button').onclick=()=>control('close');$('offset-label').textContent=`Lyrics offset ${offset>=0?'+':''}${(offset/1000).toFixed(1)}s`;if(config.nativeAudio)$('audio-button').textContent='Reconnect Spotify audio';
  window.__stageTest={setState:applyState,setAudio:(wave,fft)=>{testAudio=wave?{wave:Uint8Array.from(wave),fft:Uint8Array.from(fft||new Array(1024).fill(0))}:null},renderAt:(pos,motion=pos/1000)=>{testNow=performance.now();testMotion=motion;state.position=pos;localReceived=testNow;motionTime=motion;render(testNow)},resume:()=>{testNow=null;testMotion=null;lastFrame=performance.now();requestAnimationFrame(render)},stats:()=>({role,width,height,renderWidth:canvas.width,renderHeight:canvas.height,dpr,canvasColorSpace:ctx.getContextAttributes?.().colorSpace||'srgb',renderedGlyphs,frames,lastCue,audioConnected:audioConnected(),audioSource:config.nativeAudio?'Spotify':analyser?'System loopback':null,nativePID:config.nativeAudio?state.audio?.pid??null:null,captureAttempts,rms,bass,treble,waveGain,waveThickness,waveMorphMs:morphDuration*1000,musicMotionSpeed,musicDbFS,rayMotionTime,frameMs,quality,fps,status,targetRefreshRate:config.refreshRate||60,interactions:physics.size,dragged,collision:collisionMetrics,fonts:fontStatus(),position:position(),fontLoaded:document.fonts.check('800 30px OAGothic')}),glyphs:()=>hitGlyphs.map(g=>({...g})),captureAudio:startAudio};
  Object.assign(window.__stageTest,{fluid:()=>({serial:fluidSerial,particles:fluidParticles.filter(p=>p.alive).map(p=>({...p})),water:water.stats()}),advanceFluid:(seconds,time=motionTime)=>{const duration=clamp(seconds,0,3),steps=Math.max(1,Math.ceil(duration/(1/30)));for(let i=0;i<steps;i++){water.update(duration/steps);stepPhysics(duration/steps);stepFluid(duration/steps,time+i*duration/steps)}},testField:()=>new WaterField(water.nx,water.ny),wave:()=>Array.from(displayWave),entities:()=>Array.from(cueEntities.values(),e=>({key:e.key,owner:e.owner,index:e.index,age:motionTime-e.birth,orphaned:e.orphanedAt!==null,opacity:(1-smooth((motionTime-e.birth-12)/16))*(e.orphanedAt===null?1:1-smooth((motionTime-e.orphanedAt)/7))})),palette:()=>palette.slice(),timeline:()=>timelineState(),contacts:(glyphs,input)=>{const bodies=new Map(input.map(b=>[b.id,{...newBody(b.id),...b}]));const result=solveContacts(glyphs.map(g=>({...g})),bodies);return {metrics:result,bodies:Array.from(bodies,([id,b])=>({id,...b}))}}});
  window.__stageTest.opacityAt=(screenY,age=0,orphanAge=null)=>glyphAlpha(screenY,(1-smooth((age-12)/16))*(orphanAge===null?1:1-smooth(orphanAge/7)));
  window.__stageTest.lightMask=()=>({canvas:textMaskCanvas,width:textMaskCanvas?.width||0,height:textMaskCanvas?.height||0});window.__stageTest.lightAt=(age=0,orphanAge=null)=>lightMaskAlpha(age,orphanAge);
  window.__stageTest.stepWave=dt=>sampleAudio(clamp(dt,0,.1));window.__stageTest.waveShape=()=>({display:Array.from(displayWave),target:Array.from(targetWave),velocity:Array.from(waveVelocity),morphAge:waveMorphAge,morphDuration,thickness:waveThickness,phaseShift:wavePhaseShift,phaseCorrelation:wavePhaseCorrelation,maxGeometrySpeed:MAX_WAVE_SPEED});window.__stageTest.alignmentTest=alignedWaveShift;
  window.__stageTest.stepMusic=dt=>stepMusicMotion(clamp(dt,0,.1));window.__stageTest.musicMotion=()=>({rayMotionTime,musicMotionSpeed,musicDbFS});
  window.__stageTest.waveMask=()=>({canvas:waveMaskCanvas,width:waveMaskCanvas?.width||0,height:waveMaskCanvas?.height||0});window.__stageTest.isWaveHit=isWaveHit;
  window.__stageTest.stepBeat=dt=>stepBassBeat(clamp(dt,0,.1));window.__stageTest.beat=()=>({kickEnvelope,kickDrive,bassBody,bassReference,thickness:waveThickness,active:waveSoundActive,kickCount,envelope:waveEnvelope,amplitude:waveAmplitude(),clock:beatTime});
  const baseStats=window.__stageTest.stats;window.__stageTest.stats=()=>({...baseStats(),waveRhythmRevision:'float-music-locked-curve-v14',waveEnvelope,waveAmplitude:waveAmplitude(),kickEnvelope,kickCount,documentHidden:document.hidden,audioPacketAge:config.nativeAudio?(testNow??performance.now())-lastAudioAt:null,audioSequence:state.audio?.sequence??null});
  if(window.stage?.onState)window.stage.onState(applyState);
  window.StageHDR?.init?.(config);
  // Fonts are local and must be ready before measuring the precise initial glyph layout.
  ensureFonts(['OAGothic']);document.fonts.ready.then(clearFontCaches);document.fonts.addEventListener?.('loadingdone',clearFontCaches);
  window.__stageTest.fontsReady=()=>Promise.all(loadingFonts.values());window.__stageTest.fontRouting=(text,lines=[{text}],language='')=>{const script=cueScript({text,language},trackScript(lines,language),language);return Array.from(text,ch=>({ch,family:glyphFamily(ch,script)}))};window.__stageTest.fontStatus=fontStatus;
  updateStatus();requestAnimationFrame(render);
  addEventListener('beforeunload',()=>{captureStream?.getTracks().forEach(t=>t.stop());audioContext?.close()});
})();
