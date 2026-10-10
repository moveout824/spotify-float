/* Spotify Float: one generated-icon button directly beside Repeat. */
(() => {
  'use strict';
  const BASE='http://127.0.0.1:43891', KEY=__STAGE_KEY__, ICON=__STAGE_ICON__;
  const cachedLyrics=new Map();let current='',pending=false,lastTrack='',lastLyrics='',lastPalette='';
  let button=null,active=false,palette=null,connected=false,observer=null,pollTimer=null;
  const icon=`<span class="spotify-float-icon" style="display:block;width:16px;height:16px;background:currentColor;mask:url('${ICON}') center/contain no-repeat;-webkit-mask:url('${ICON}') center/contain no-repeat"></span>`;
  const request=async(path,body)=>{
    const response=await fetch(BASE+path,{method:'POST',headers:{'Content-Type':'application/json','X-Stage-Key':KEY},body:JSON.stringify(body),signal:AbortSignal.timeout(2500)});
    if(!response.ok)throw new Error('Local bridge unavailable');return response.json();
  };
  function readTrack(){
    const item=Spicetify.Player.data?.item;if(!item?.uri||!item.uri.startsWith('spotify:track:'))return null;
    const m=item.metadata||{};let cover=m.image_xlarge_url||m.image_large_url||m.image_url||'';
    if(cover.startsWith('spotify:image:'))cover='https://i.scdn.co/image/'+cover.slice(14);
    return {id:item.uri,title:m.title||item.name||'',artist:m.artist_name||m.album_artist_name||'',album:m.album_title||'',cover,duration:Spicetify.Player.getDuration()};
  }
  function snapshot(full=false){
    const track=readTrack();if(!track)return {};
    const state={track,position:Spicetify.Player.getProgress(),isPlaying:Spicetify.Player.isPlaying()};
    if(cachedLyrics.has(track.id)&&(full||lastLyrics!==track.id)){state.lyrics=cachedLyrics.get(track.id);lastLyrics=track.id;}
    if(palette&&(full||lastPalette!==track.id)){state.palette=palette;lastPalette=track.id;}
    return state;
  }
  function updateButton(){
    if(!button)return;button.active=active;button.element.dataset.stageActive=String(active);button.element.setAttribute('aria-pressed',String(active));
    button.label=active?'Float 화면 닫기':'Float · Lyrics and Waveform';
  }
  function place(){
    const repeat=document.querySelector('[data-testid="control-button-repeat"]');if(!repeat||!button)return;
    const element=button.element;
    if(repeat.nextElementSibling!==element){
      element.className=repeat.className;element.classList.remove('control-button-repeat');element.classList.add('spotify-float-control');
      const rect=repeat.getBoundingClientRect();element.style.width=rect.width+'px';element.style.height=rect.height+'px';element.style.minWidth=rect.width+'px';element.style.padding='0';element.style.position='relative';element.style.flexShrink='0';
      repeat.insertAdjacentElement('afterend',element);updateButton();
    }
  }
  async function getTrackExtras(track){
    const id=track.id;palette=null;
    // Artwork colors and lyrics are independent; a slow color endpoint must
    // never delay the first timed lyric line.
    void (async()=>{try {
      const colors=await Spicetify.colorExtractor(id);
      if(current===id){palette={colors:[colors.vibrant,colors.prominent,colors.lightVibrant].filter(x=>typeof x==='string'&&/^#[0-9a-f]{6}$/i.test(x))};lastPalette='';}
    } catch{}})();
    if(cachedLyrics.has(id))return;
    try {
      const response=await Spicetify.CosmosAsync.get('https://spclient.wg.spotify.com/color-lyrics/v2/track/'+id.split(':')[2]+'?format=json&vocalRemoval=false&market=from_token');
      if(!response?.lyrics?.lines?.length)return;
      const synced=response.lyrics.syncType==='LINE_SYNCED';
      const lines=response.lyrics.lines.map((line,index)=>({time:synced?Number(line.startTimeMs):Math.round(10000+index*Math.max(1000,(track.duration-20000)/response.lyrics.lines.length)),text:line.words||''}));
      cachedLyrics.set(id,{trackId:id,lines,synced,source:'Spotify'});while(cachedLyrics.size>32)cachedLyrics.delete(cachedLyrics.keys().next().value);
      if(current===id)lastLyrics='';
    } catch{}
  }
  async function poll(){
    if(pending)return;pending=true;
    try {
      const track=readTrack();
      if(track&&track.id!==current){current=track.id;lastLyrics='';lastPalette='';getTrackExtras(track);}
      const result=await request('/state',snapshot(!connected||lastTrack!==current));connected=true;lastTrack=current;
      if(active!==Boolean(result.active)){active=Boolean(result.active);updateButton();}
      if(result.wantLyrics && cachedLyrics.has(current))lastLyrics='';
      for(const command of result.commands||[]){if(command==='togglePlayback')Spicetify.Player.togglePlay();else if(command?.type==='seek'&&Number.isFinite(command.position))Spicetify.Player.seek(command.position);}
    } catch {connected=false;lastLyrics='';lastPalette='';}
    finally{pending=false;pollTimer=setTimeout(poll,active?220:800);}
  }
  async function onClick(){
    try{const result=await request('/toggle',snapshot(true));active=Boolean(result.active);updateButton();}
    catch{
      // Registered local launcher starts the bridge if it was explicitly quit.
      const link=document.createElement('a');link.href='spotify-stage://toggle';link.style.display='none';document.body.appendChild(link);link.click();link.remove();
      Spicetify.showNotification('Starting Float. Your visuals will open shortly.');
    }
  }
  function init(){
    if(!window.Spicetify?.Player?.data||!Spicetify.Playbar?.Button){setTimeout(init,250);return;}
    if(window.__spotifyFloat)return;
    const style=document.createElement('style');style.textContent=`.spotify-float-control{color:var(--text-subdued,#b3b3b3)!important;background:transparent;border:0;display:flex;align-items:center;justify-content:center;cursor:pointer}.spotify-float-control:hover{color:#fff!important}.spotify-float-control[data-stage-active=true]{color:#1ed760!important}.spotify-float-control[data-stage-active=true]:after{content:'';position:absolute;width:4px;height:4px;border-radius:50%;background:currentColor;bottom:0;left:calc(50% - 2px)}.spotify-float-control:focus-visible{outline:2px solid #fff;outline-offset:2px}`;document.head.appendChild(style);
    button=new Spicetify.Playbar.Button('Float · Lyrics and Waveform',icon,onClick,false,false,false);
    button.element.dataset.testid='spotify-stage-button';button.element.setAttribute('aria-label','Float · Lyrics and Waveform');
    let queued=false;observer=new MutationObserver(()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;place();});});
    observer.observe(document.body,{subtree:true,childList:true});place();poll();
    window.__spotifyFloat={button,stats:()=>({connected,active,track:current,besideRepeat:document.querySelector('[data-testid="control-button-repeat"]')?.nextElementSibling===button.element}),dispose:()=>{clearTimeout(pollTimer);observer.disconnect();button.element.remove();style.remove();delete window.__spotifyFloat;}};
  }
  init();
})();
