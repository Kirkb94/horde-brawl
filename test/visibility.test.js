const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const page=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
const source=page.slice(page.indexOf('function visualCanSee('),page.indexOf('function inFlare('));
function fixture(){const c={Math,TAU:Math.PI*2,NEAR:25,vr:()=>200,fv:()=>Math.PI/2,angDiff:(a,b)=>Math.atan2(Math.sin(b-a),Math.cos(b-a)),rayCast:(x,y,a,d)=>d};vm.createContext(c);vm.runInContext(source,c);return c}
test('marks, scans and firing do not reveal enemies outside sight or through walls',()=>{const c=fixture(),p={x:0,y:0,facing:0};for(const flags of [{},{markT:5},{tagT:5,tagBy:0},{litT:5}]){assert.equal(c.visualCanSee(p,{x:100,y:0,...flags}),true);assert.equal(c.visualCanSee(p,{x:220,y:0,...flags}),false);assert.equal(c.visualCanSee(p,{x:-100,y:0,...flags}),false);c.rayCast=()=>40;assert.equal(c.visualCanSee(p,{x:100,y:0,...flags}),false);c.rayCast=(x,y,a,d)=>d;}});
test('near awareness still respects walls; cloaking remains hidden beyond close range',()=>{const c=fixture(),p={x:0,y:0,facing:0};assert.equal(c.visualCanSee(p,{x:-10,y:0}),true);c.rayCast=()=>5;assert.equal(c.visualCanSee(p,{x:-10,y:0}),false);c.rayCast=(x,y,a,d)=>d;assert.equal(c.visualCanSee(p,{x:160,y:0,cloakT:2}),false)});
test('effect mask clips its cone and nearby awareness against walls',()=>{const c=fixture(),points=[];let clips=0;c.ctx={beginPath(){},moveTo(x,y){points.push([x,y])},lineTo(x,y){points.push([x,y])},closePath(){},clip(){clips++}};c.rayCast=(x,y,a,d)=>Math.min(10,d);c.clipPlayerSight({x:0,y:0,facing:0});assert.equal(clips,1);assert.ok(points.length>200);assert.ok(points.every(([x,y])=>Math.hypot(x,y)<=10.0001));});

test('Argus scan preview draws only its area without querying enemies',()=>{
 const start=page.indexOf('function drawAimInd('),end=page.indexOf('\n}',start)+2,zones=[];
 const c={Math,AIM:{slot:'q',t:0,src:'key'},CPAL:{carbine:{acc:'#fff'}},CHARS:{carbine:{ab:'Scan'}},aimPoint:()=>({x:100,y:0}),scanR:()=>650,aimZone:(...v)=>zones.push(v),aimLabel(){},G:{get fighters(){throw Error('Scan preview must not inspect enemies')}}};
 vm.createContext(c);vm.runInContext(page.slice(start,end),c);c.drawAimInd({alive:true,weapon:'carbine',st:{fx:{}},x:0,y:0,facing:0});assert.equal(zones.length,1);assert.equal(zones[0][2],650);
});
test('all ability previews omit target markers and the full game script parses',()=>{
 assert.equal(page.includes('aimMark('),false);
 for(const match of page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
});
