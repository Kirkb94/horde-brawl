const test=require('node:test'),assert=require('node:assert/strict');
const {startServer,connect}=require('./helpers');
const {validateMsg}=require('../validate');
test('ready state requires a boolean',()=>{assert.equal(validateMsg({t:'upd',ready:'true'}).ok,false);assert.equal(validateMsg({t:'upd',ready:true}).ok,true)});
for(const mode of ['auth','relay'])test(`${mode}: everyone readies, changes reset readiness, and lobby return clears it`,async t=>{
 const srv=await startServer({MODE:mode});t.after(()=>srv.stop());
 const a=await connect(srv);a.send({t:'create',name:'A',weapon:'rifle'});const j=await a.waitFor('joined');
 const b=await connect(srv);b.send({t:'join',code:j.code,name:'B',weapon:'rifle'});await b.waitFor('joined');
 a.send({t:'start'});assert.match((await a.waitFor('err')).msg,/ready up/);
 async function ready(){a.send({t:'upd',ready:true});b.send({t:'upd',ready:true});await a.waitFor('players',3000,m=>m.players.length===2&&m.players.every(p=>p.ready));}
 await ready();b.send({t:'upd',weapon:'sniper'});await a.waitFor('players',3000,m=>m.players.some(p=>p.weapon==='sniper'&&!p.ready));
 a.send({t:'start'});assert.match((await a.waitFor('err')).msg,/ready up/);
 await ready();a.send({t:'cfg',map:'camp'});await a.waitFor('players',3000,m=>m.cfg.map==='camp'&&m.players.every(p=>!p.ready));
 await ready();b.send({t:'upd',ready:false});await a.waitFor('players',3000,m=>m.players.some(p=>p.name==='B'&&!p.ready));
 await ready();a.send({t:'start'});await a.waitFor('players',10000,m=>m.started);
 a.send({t:'lobby'});await a.waitFor('players',3000,m=>!m.started&&m.cfg.map==='camp'&&m.players.every(p=>!p.ready));
});
