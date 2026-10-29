const test=require('node:test'),assert=require('node:assert/strict');
const {startServer,connect,sleep}=require('./helpers');
for(const mode of ['auth','relay'])test(`${mode}: countdown synchronizes, cancels, and starts once`,async t=>{
 const srv=await startServer({MODE:mode});t.after(()=>srv.stop());
 const a=await connect(srv);a.send({t:'create',name:'A',weapon:'rifle'});const j=await a.waitFor('joined');
 const b=await connect(srv);b.send({t:'join',code:j.code,name:'B',weapon:'rifle'});await b.waitFor('joined');
 a.send({t:'upd',ready:true});b.send({t:'upd',ready:true});await a.waitFor('players',3000,m=>m.players.every(p=>p.ready));
 a.send({t:'start'});
 for(const c of [a,b])assert.equal((await c.waitFor('players',3000,m=>m.countdown===3)).started,false);
 b.send({t:'upd',ready:false});await a.waitFor('players',3000,m=>m.countdown===0&&!m.players.every(p=>p.ready));
 await sleep(3200);assert.equal(a.queue.some(m=>m.started),false);
 b.send({t:'upd',ready:true});await a.waitFor('players',3000,m=>m.players.every(p=>p.ready));
 a.send({t:'start'});const start=Date.now();await a.waitFor('players',3000,m=>m.countdown===3);
 a.send({t:'start'});
 for(const n of [2,1])for(const c of [a,b])await c.waitFor('players',3000,m=>m.countdown===n&&!m.started);
 await a.waitFor('players',10000,m=>m.started&&m.countdown===0);assert.ok(Date.now()-start>=2900);
});
