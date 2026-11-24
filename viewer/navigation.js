'use strict';

const navCellSize=.20;
const navMaxRadius=80;
const navStride=1024;
const navOffset=navStride/2;
const obstaclePadding=.025;

function navigationKey(x,y) {
    const col=Math.floor(x/navCellSize)+navOffset;
    const row=Math.floor(y/navCellSize)+navOffset;
    if(col<0||col>=navStride||row<0||row>=navStride) return -1;
    return row*navStride+col;
}

function buildNavigation(points,start) {
    const [ox,oy,eyeHeight]=start;
    const guess=eyeHeight-1.6, binWidth=.05, window=.65;
    const bins=Array.from({length:27},()=>new Map());
    for(let i=0;i<points.length;i+=4) {
        if(points[i+3]<.22) continue;
        const x=points[i]-ox,y=points[i+1]-oy;
        if(x*x+y*y>2.5**2) continue;
        const h=points[i+2]-guess;
        const bin=Math.round((h+window)/binWidth);
        if(bins[bin]) {
            const key=navigationKey(x,y);
            const sample=bins[bin].get(key)??[0,0];
            sample[0]+=points[i+2];
            sample[1]++;
            bins[bin].set(key,sample);
        }
    }
    let best=0,size=0;
    for(let i=0;i<bins.length;i++) {
        const score=bins[i].size*(1-.4*Math.abs(i*binWidth-window)/window);
        if(score>size) {best=i;size=score;}
    }
    if(size<9) return {floor:null,walkable:new Int32Array(),blocked:new Float32Array()};
    // Average each cell once so dense foreground splats cannot pull the level up.
    const samples=[...bins[best].values()].map(([sum,count])=>sum/count).sort((a,b)=>a-b);
    const floor=samples[Math.floor(samples.length/2)];
    const cells=new Map();
    for(let i=0;i<points.length;i+=4) {
        if(points[i+3]<.18) continue;
        const x=points[i]-ox,y=points[i+1]-oy,z=points[i+2]-floor;
        if(Math.abs(x)>navMaxRadius||Math.abs(y)>navMaxRadius||z<-.12||z>1.72) continue;
        const key=navigationKey(x,y);
        const cell=cells.get(key)??[0,0,0,0,0,0,Infinity,Infinity,-Infinity,-Infinity];
        if(!cells.has(key)) cells.set(key,cell);
        if(z<=.105) cell[0]++;
        else if(z>.18) {
            cell[1+Math.min(4,Math.floor((z-.18)/.31))]++;
            cell[6]=Math.min(cell[6],x);
            cell[7]=Math.min(cell[7],y);
            cell[8]=Math.max(cell[8],x);
            cell[9]=Math.max(cell[9],y);
        }
    }
    const walkable=[],blocked=[],obstructed=new Set();
    for(const [key,cell] of cells) {
        const ground=cell[0],body=cell.slice(1,6);
        const occupied=body.filter(n=>n>=5).length;
        // Upright surfaces span several bands. Dense low obstacles also block landing.
        if(occupied>=3||(body[0]>=16&&body[1]>=8)||body[0]>=40) {
            const top=body.findLastIndex(n=>n>=5);
            // Keep the measured footprint of a jamb instead of filling its entire cell.
            blocked.push(key,top===4?2:.18+(top+1)*.31,
                cell[6]-obstaclePadding,cell[7]-obstaclePadding,
                cell[8]+obstaclePadding,cell[9]+obstaclePadding);
            obstructed.add(key);
        }
        if(ground>=4) walkable.push(key);
    }
    const filled=fillFloorHoles(walkable,obstructed);
    return {floor,walkable:Int32Array.from(filled),blocked:Float32Array.from(blocked)};
}

function fillFloorHoles(walkable,blocked) {
    const observed=new Set(walkable.filter(key=>!blocked.has(key)));
    const filled=[...walkable];
    const neighbors=[-navStride-1,-navStride,-navStride+1,-1,1,navStride-1,navStride,navStride+1];
    // Each candidate has a measured cell to its left. Use measured floor only
    // so the fill cannot grow into a larger gap or beyond the scan.
    for(const left of observed) {
        const key=left+1;
        if(key%navStride<=0||key%navStride>=navStride-1||observed.has(key)||blocked.has(key)) continue;
        if(neighbors.every(offset=>observed.has(key+offset))) filled.push(key);
    }
    return filled;
}

function readNavigation(data,start) {
    const blocked=new Map();
    for(let i=0;i<data.blocked.length;i+=6) {
        blocked.set(data.blocked[i],data.blocked.subarray(i+1,i+6));
    }
    return {floor:data.floor,walkable:new Set(data.walkable),blocked,origin:start};
}

const teleportStep=navCellSize/4;
const landingRadius=.4;

function cellAt(nav,x,y) {
    return navigationKey(x-nav.origin[0],y-nav.origin[1]);
}

function segmentEntry(start,delta,min,max) {
    let enter=0,leave=1;
    for(let axis=0;axis<3;axis++) {
        if(delta[axis]===0) {
            if(start[axis]<min[axis]||start[axis]>max[axis]) return Infinity;
        } else {
            const a=(min[axis]-start[axis])/delta[axis];
            const b=(max[axis]-start[axis])/delta[axis];
            enter=Math.max(enter,Math.min(a,b));
            leave=Math.min(leave,Math.max(a,b));
            if(enter>leave) return Infinity;
        }
    }
    return enter;
}

function teleportObstruction(nav,from,to) {
    const [ox,oy]=nav.origin;
    const start=[from[0]-ox,from[1]-oy,from[2]-nav.floor];
    const end=[to[0]-ox,to[1]-oy,to[2]-nav.floor];
    const delta=end.map((value,i)=>value-start[i]);
    const left=Math.floor((Math.min(start[0],end[0])-obstaclePadding)/navCellSize);
    const right=Math.floor((Math.max(start[0],end[0])+obstaclePadding)/navCellSize);
    const bottom=Math.floor((Math.min(start[1],end[1])-obstaclePadding)/navCellSize);
    const top=Math.floor((Math.max(start[1],end[1])+obstaclePadding)/navCellSize);
    let nearest=Infinity;
    for(let row=bottom;row<=top;row++) {
        for(let col=left;col<=right;col++) {
            const obstacle=nav.blocked.get(navigationKey((col+.5)*navCellSize,(row+.5)*navCellSize));
            if(!obstacle) continue;
            const [height,x1,y1,x2,y2]=obstacle;
            nearest=Math.min(nearest,segmentEntry(start,delta,[x1,y1,0],[x2,y2,height]));
        }
    }
    return Number.isFinite(nearest)?from.map((value,i)=>value+delta[i]*nearest):null;
}

function canLand(nav,x,y) {
    if(!nav.walkable.has(cellAt(nav,x,y))) return false;
    // Check clearance against each occupied cell that overlaps the landing capsule.
    const [ox,oy]=nav.origin;
    const reach=landingRadius+obstaclePadding;
    const left=Math.floor((x-ox-reach)/navCellSize);
    const right=Math.floor((x-ox+reach)/navCellSize);
    const bottom=Math.floor((y-oy-reach)/navCellSize);
    const top=Math.floor((y-oy+reach)/navCellSize);
    for(let row=bottom;row<=top;row++) {
        for(let col=left;col<=right;col++) {
            const px=ox+col*navCellSize,py=oy+row*navCellSize;
            const obstacle=nav.blocked.get(cellAt(nav,px+navCellSize/2,py+navCellSize/2));
            if(!obstacle) continue;
            const dx=Math.max(ox+obstacle[1]-x,x-ox-obstacle[3],0);
            const dy=Math.max(oy+obstacle[2]-y,y-oy-obstacle[4],0);
            if(dx*dx+dy*dy<landingRadius**2) return false;
        }
    }

    return true;
}

function navigationSpawn(nav) {
    const [ox,oy]=nav.origin;
    if(nav.floor===null||canLand(nav,ox,oy)) return [ox,oy];
    let nearest=[ox,oy],best=2.5**2;
    for(const key of nav.walkable) {
        const dx=(key%navStride-navOffset+.5)*navCellSize;
        const dy=(Math.floor(key/navStride)-navOffset+.5)*navCellSize;
        const distance=dx*dx+dy*dy;
        if(distance<best&&canLand(nav,ox+dx,oy+dy)) {
            best=distance;
            nearest=[ox+dx,oy+dy];
        }
    }
    return nearest;
}

function validTeleport(nav,from,to) {
    const [x,y]=to;
    if(!canLand(nav,x,y)||teleportObstruction(nav,[from[0],from[1],nav.floor],to)) return false;
    // The scan has a single inferred floor. Reject crossings of walls and unscanned gaps.
    const dx=x-from[0],dy=y-from[1];
    const steps=Math.max(1,Math.ceil(Math.hypot(dx,dy)/teleportStep));
    for(let i=1;i<=steps;i++) {
        const t=i/steps,px=from[0]+dx*t,py=from[1]+dy*t;
        const cell=cellAt(nav,px,py);
        if(i>3&&!nav.walkable.has(cell)) return false;
    }
    return true;
}

function evaluateArcCurve(value,min,max,start,end,outSlope,inSlope) {
    const t=Math.max(0,Math.min(1,(value-min)/(max-min)));
    const smooth=t*t*(3-2*t);
    return start+(end-start)*smooth+(max-min)*t*(1-t)*((1-t)*outSlope-t*inSlope);
}

function controllerTeleportArc(hand,direction,stabilizer) {
    const horizontal=Math.hypot(direction[0],direction[1]);
    if(horizontal<1e-6) return null;
    // The native curve uses signed pitch in degrees.
    const pitch=Math.atan2(direction[2],horizontal)*180/Math.PI;
    const angle=evaluateArcCurve(pitch,-90,90,-90,90,1,.57833147)*Math.PI/180;
    const distance=Math.hypot(hand[0]-stabilizer[0],hand[1]-stabilizer[1]);
    const speed=evaluateArcCurve(distance,.1,1,5,20,49.800457,0);
    const vx=direction[0]/horizontal*Math.cos(angle)*speed;
    const vy=direction[1]/horizontal*Math.cos(angle)*speed;
    const vz=Math.sin(angle)*speed;
    return Array.from({length:30},(_,i)=>{
        const t=i/29;
        const z=hand[2]+vz*t-.5*9.81*2.3*t*t;
        return [hand[0]+vx*t,hand[1]+vy*t,i===29?Math.min(z,hand[2]-2):z];
    });
}

function teleportArcLanding(nav,head,arc,visible) {
    if(!arc||teleportObstruction(nav,head,arc[0])) return null;
    visible?.push(arc[0]);
    for(let i=1;i<arc.length;i++) {
        const from=arc[i-1],to=arc[i];
        const crossesFloor=from[2]>=nav.floor&&to[2]<nav.floor;
        let end=to;
        if(crossesFloor) {
            const t=(from[2]-nav.floor)/(from[2]-to[2]);
            end=[from[0]+(to[0]-from[0])*t,from[1]+(to[1]-from[1])*t,nav.floor];
        }
        const obstruction=teleportObstruction(nav,from,end);
        visible?.push(obstruction??end);
        if(obstruction) return null;
        if(crossesFloor) return validTeleport(nav,head,end)?end:null;
    }
    return null;
}
