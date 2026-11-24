'use strict';

const navCellSize=.20;
const navMaxRadius=80;
const navStride=1024;
const navOffset=navStride/2;

function navigationKey(x,y) {
    const col=Math.floor(x/navCellSize)+navOffset;
    const row=Math.floor(y/navCellSize)+navOffset;
    if(col<0||col>=navStride||row<0||row>=navStride) return -1;
    return row*navStride+col;
}

function buildNavigation(points,start) {
    const [ox,oy,eyeHeight]=start;
    const guess=eyeHeight-1.6, binWidth=.05, window=.65;
    const bins=Array.from({length:27},()=>new Set());
    for(let i=0;i<points.length;i+=4) {
        if(points[i+3]<.22) continue;
        const x=points[i]-ox,y=points[i+1]-oy;
        if(x*x+y*y>2.5**2) continue;
        const h=points[i+2]-guess;
        const bin=Math.round((h+window)/binWidth);
        if(bins[bin]) bins[bin].add(navigationKey(x,y));
    }
    let best=0,size=0;
    for(let i=0;i<bins.length;i++) {
        const score=bins[i].size*(1-.4*Math.abs(i*binWidth-window)/window);
        if(score>size) {best=i;size=score;}
    }
    if(size<9) return {floor:guess,walkable:new Int32Array(),blocked:new Int32Array()};
    const floor=guess-window+best*binWidth;
    const cells=new Map();
    for(let i=0;i<points.length;i+=4) {
        if(points[i+3]<.18) continue;
        const x=points[i]-ox,y=points[i+1]-oy,z=points[i+2]-floor;
        if(Math.abs(x)>navMaxRadius||Math.abs(y)>navMaxRadius||z<-.12||z>1.72) continue;
        const key=navigationKey(x,y);
        const cell=cells.get(key)??[0,0,0,0,0,0];
        if(!cells.has(key)) cells.set(key,cell);
        if(z<=.105) cell[0]++;
        else if(z>.18) cell[1+Math.min(4,Math.floor((z-.18)/.31))]++;
    }
    const walkable=[],blocked=[];
    for(const [key,[ground,...body]] of cells) {
        const occupied=body.filter(n=>n>=5).length;
        // Upright surfaces span several bands. Dense low obstacles also block landing.
        if(occupied>=3||(body[0]>=16&&body[1]>=8)||body[0]>=40) blocked.push(key);
        if(ground>=4) walkable.push(key);
    }
    return {floor,walkable:Int32Array.from(walkable),blocked:Int32Array.from(blocked)};
}

function readNavigation(data,start) {
    return {floor:data.floor,walkable:new Set(data.walkable),blocked:new Set(data.blocked),origin:start};
}

const teleportMinDistance=.25;
const teleportMaxDistance=5;
const teleportStep=navCellSize*.2;
const landingOffsets=[[.16,0],[-.16,0],[0,.16],[0,-.16]];

function teleportRay(nav,from,to,stopAtFirstBoundary) {
    const [ox,oy]=nav.origin;
    const dx=to[0]-from[0],dy=to[1]-from[1];
    const distance=Math.hypot(dx,dy);
    if(distance<teleportMinDistance||(!stopAtFirstBoundary&&distance>teleportMaxDistance)) return null;
    const end=Math.min(distance,teleportMaxDistance);
    const ux=dx/distance,uy=dy/distance;
    const sideX=-uy*.12,sideY=ux*.12;
    const key=(x,y)=>navigationKey(x-ox,y-oy);
    const supported=(x,y)=>{
        const cell=key(x,y);
        return nav.walkable.has(cell)&&!nav.blocked.has(cell);
    };
    const xAt=d=>from[0]+ux*d, yAt=d=>from[1]+uy*d;
    function corridor(d) {
        const x=xAt(d),y=yAt(d),cell=key(x,y);
        if(cell===-1||nav.blocked.has(cell)) return false;
        return d<.22||(supported(x,y)&&supported(x+sideX,y+sideY)&&supported(x-sideX,y-sideY));
    }
    function landing(d) {
        const x=xAt(d),y=yAt(d);
        return d>=teleportMinDistance&&landingOffsets.every(([a,b])=>supported(x+a,y+b));
    }
    let lastLanding=0;
    // Sample from the player outward. A farther aim point uses the same samples up to the wall.
    for(let i=1;;i++) {
        const at=Math.min(end,i*teleportStep);
        if(!corridor(at)) {
            if(!stopAtFirstBoundary) return null;
            break;
        }
        if(landing(at)) lastLanding=at;
        if(at===end) {
            if(at===lastLanding) return [xAt(at),yAt(at),nav.floor];
            if(!stopAtFirstBoundary) return null;
            break;
        }
    }
    if(!lastLanding||!stopAtFirstBoundary) return null;
    // Refine between the last valid sample and the first invalid sample.
    let lo=lastLanding,hi=Math.min(end,lastLanding+teleportStep);
    for(let i=0;i<5;i++) {
        const mid=(lo+hi)*.5;
        if(corridor(mid)&&landing(mid)) lo=mid;
        else hi=mid;
    }
    return [xAt(lo),yAt(lo),nav.floor];
}

function validTeleport(nav,from,to) {
    return !!teleportRay(nav,from,to,false);
}

function limitTeleport(nav,from,candidate) {
    return teleportRay(nav,from,candidate,true);
}
