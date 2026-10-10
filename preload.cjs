'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const argument=process.argv.find(x=>x.startsWith('--stage-config='));
const config=argument ? JSON.parse(Buffer.from(argument.slice(15),'base64').toString('utf8')) : {};
contextBridge.exposeInMainWorld('stage',{
  config,
  onState(callback){const listener=(_,state)=>callback(state);ipcRenderer.on('stage-state',listener);ipcRenderer.invoke('stage-initial-state').then(callback);return ()=>ipcRenderer.removeListener('stage-state',listener);},
  control(action){ipcRenderer.send('stage-control',action);},
  setOffset(milliseconds){ipcRenderer.send('stage-offset',milliseconds);},
  report(stats){ipcRenderer.send('stage-stats',stats);},
  reconnectAudio(){ipcRenderer.send('stage-audio-reconnect');}
});
