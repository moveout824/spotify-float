'use strict';
const normalize = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function parseLrc(text) {
  const result=[];
  let offset=0;
  for (const row of String(text||'').split(/\r?\n/)) {
    const tag=/\[offset:([+-]?\d+)\]/i.exec(row);
    if(tag) offset=Number(tag[1]);
  }
  for(const row of String(text||'').split(/\r?\n/)) {
    const timestamps=[...row.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const text=row.replace(/\[[^\]]*\]/g,'').trim();
    for(const stamp of timestamps) {
      const fraction=stamp[3] ? Number('0.'+stamp[3]) : 0;
      const time=Math.max(0,(Number(stamp[1])*60+Number(stamp[2])+fraction)*1000+offset);
      result.push({time:Math.round(time),text});
    }
  }
  return result.sort((a,b)=>a.time-b.time);
}
function approximate(text,duration) {
  const lines=String(text||'').split(/\r?\n/).map(t=>t.trim()).filter(Boolean);
  if(!lines.length) return [];
  const start=Math.min(12000,duration*.08), end=Math.max(start+1000,duration-Math.min(10000,duration*.06));
  const weights=lines.map(t=>Math.max(8,[...t].length)), sum=weights.reduce((a,b)=>a+b,0);
  let elapsed=0;
  return lines.map((text,i)=>{const time=start+(end-start)*elapsed/sum;elapsed+=weights[i];return {time:Math.round(time),text};});
}
function candidate(record,track) {
  const duration=Number(track.duration)/1000;
  const title=normalize(track.title), artist=normalize(track.artist);
  const candidateTitle=normalize(record.trackName), candidateArtist=normalize(record.artistName);
  const titleMatch=title===candidateTitle;
  const artistMatch=artist===candidateArtist || (artist.length>3 && candidateArtist.includes(artist));
  const difference=Math.abs(Number(record.duration||0)-duration);
  if(!titleMatch || !artistMatch || difference>8) return -Infinity;
  return 100-difference+(record.syncedLyrics?20:0)+(normalize(record.albumName)===normalize(track.album)?5:0);
}
async function getLyrics(track,signal) {
  const headers={'User-Agent':'SpotifyStage/1.0 (https://spicetify.app/)', 'Accept':'application/json'};
  const query=new URLSearchParams({track_name:track.title,artist_name:track.artist,album_name:track.album||'',duration:String(Math.round(track.duration/1000))});
  let record=null;
  try {
    const response=await fetch('https://lrclib.net/api/get?'+query,{headers,signal});
    if(response.ok) record=await response.json();
  } catch(error) {if(signal?.aborted) throw error;}
  if(!record) {
    const response=await fetch('https://lrclib.net/api/search?'+new URLSearchParams({track_name:track.title,artist_name:track.artist}),{headers,signal});
    if(response.ok) {
      const rows=await response.json();
      if(Array.isArray(rows)) record=rows.map(row=>({row,score:candidate(row,track)})).filter(x=>Number.isFinite(x.score)).sort((a,b)=>b.score-a.score)[0]?.row||null;
    }
  }
  if(!record) return {lines:[],synced:false,source:'none',instrumental:false};
  const synced=parseLrc(record.syncedLyrics);
  return {lines:synced.length?synced:approximate(record.plainLyrics,track.duration),synced:synced.length>0,source:'LRCLIB',instrumental:Boolean(record.instrumental)};
}
module.exports={parseLrc,approximate,candidate,getLyrics};
