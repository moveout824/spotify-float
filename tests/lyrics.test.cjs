const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseLrc,approximate,candidate}=require('../lyrics.cjs');
test('multiple LRC timestamps, fractions, blank instrumental cue and offset remain accurate',()=>{
 const lines=parseLrc('[offset:-120]\n[00:01.50][01:02.001]원본 문장\n[00:04.12]\n[ar:author]');
 assert.deepEqual(lines,[{time:1380,text:'원본 문장'},{time:4000,text:''},{time:61881,text:'원본 문장'}]);
});
test('unsynced lyrics stay literal with increasing approximate timing',()=>{
 const lines=approximate('한 줄\n긴 두 번째 문장\n끝',180000);
 assert.equal(lines[1].text,'긴 두 번째 문장');assert.ok(lines[0].time<lines[1].time);assert.ok(lines[1].time<lines[2].time);assert.ok(lines[2].time<180000);
});
test('wrong recording and wrong artist are never chosen as fallback',()=>{
 const track={title:'Same Song',artist:'Artist',album:'Album',duration:180000};
 assert.equal(candidate({trackName:'Same Song',artistName:'Other',duration:180},track),-Infinity);
 assert.equal(candidate({trackName:'Same Song',artistName:'Artist',duration:201},track),-Infinity);
 assert.ok(candidate({trackName:'Same Song',artistName:'Artist',duration:180,syncedLyrics:'yes'},track)>100);
});
