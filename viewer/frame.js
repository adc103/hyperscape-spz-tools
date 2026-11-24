let frame={};
const frameNumber=(value,min,max)=> typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const validVec=(v,n)=> Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);

async function openFrame(file) {
    if (!file) return;
    try {
        if(file.size>80_000_000) throw Error('Frame settings file is too large.');
        const next=JSON.parse(await file.text());
        if(!next||typeof next!=='object'||Array.isArray(next)) throw Error('Expected a frame settings JSON object.');
        const ranges={
            near:[.0001,100],far:[.001,100000],width:[128,4096],height:[128,4096],
            depthOffset:[-5,5],foveationRadius:[0,2],mipFadePercent:[0,100],
            detailNear:[0,1],detailFar:[0,1],distanceNear:[0,1000],distanceFar:[0,1000],
            detailFade:[0,1],maxSplats:[1,limit],gpuBudgetMs:[1,1000],clipDepth:[0,1]
        };
        for(const [key,[min,max]] of Object.entries(ranges)) {
            if(next[key]!==undefined&&!frameNumber(next[key],min,max)) throw Error('Invalid frame setting '+key+'.');
        }
        if((next.far??1500)<=(next.near??.1)||(next.distanceFar??6)<=(next.distanceNear??2))
            throw Error('Each far distance must exceed its near distance.');
        if(next.eyes!==undefined) {
            if(!Array.isArray(next.eyes)||!next.eyes.length||next.eyes.length>2) throw Error('Provide one or two eyes.');
            for(const eye of next.eyes) {
                if(!eye||!validVec(eye.position,3)||!validVec(eye.forward,3)||!validVec(eye.down,3)||!validVec(eye.right,3)||
                    !validVec(eye.tan,2)||eye.tan.some(x=>x<=0)||!validVec(eye.shift??[0,0],2)||!validVec(eye.fovea??[0,0],2))
                    throw Error('Invalid eye basis or projection.');
                const {right,down,forward}=eye;
                const lengths=[dot(right,right),dot(down,down),dot(forward,forward)];
                if(lengths.some(x=>Math.abs(1-x)>.002)||Math.abs(dot(right,down))>.002||
                    Math.abs(dot(right,forward))>.002||Math.abs(dot(down,forward))>.002)
                    throw Error('Eye directions must form an orthonormal basis.');
                if(eye.depth) {
                    const {width,height,meters}=eye.depth;
                    if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>4_000_000||
                        !Array.isArray(meters)||meters.length!==width*height||!meters.every(d=>frameNumber(d,0,100000)))
                        throw Error('Invalid linear depth image.');
                    eye.depth.meters=Float32Array.from(meters);
                }
            }
        }
        if(next.frontToBack!==undefined&&typeof next.frontToBack!=='boolean') throw Error('Invalid blend order.');
        if(next.alpha) {
            const a=next.alpha;
            if(!frameNumber(a.power??1,.001,50)||!frameNumber(a.threshold??1,0,1)||
               !frameNumber(a.boost??1,0,50)||!frameNumber(a.offset??0,-5,5)||
               !frameNumber(a.cutoff??0,0,1)) throw Error('Invalid alpha composition controls.');
        }
        frame=next;
        $('clearFrame').hidden=false;
        $('frameStatus').textContent=file.name+(frame.eyes?' · calibrated pose locked':'');
        status(filename || 'Frame settings loaded');
        tick=0;
        requestRender();
    } catch(error) {status(error.message,true);}
}
$('openFrame').onclick=()=>$('frameFile').click();
$('frameFile').onchange=event=>{openFrame(event.target.files[0]);event.target.value='';};
$('clearFrame').onclick=()=>{
    frame={};
    $('clearFrame').hidden=true;
    $('frameStatus').textContent='Optional JSON for calibrated eyes, scene depth and render controls.';
    status(filename||'Files stay on this device.');
    tick=0;
    requestRender();
};
