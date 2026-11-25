const radians = Math.PI / 180;
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const toPly = ([x,y,z]) => [x,-z,y];

export function cameraFrame(pose, aspect) {
    const [x,y,z,yawDegrees,pitchDegrees,fov,rollDegrees] = pose;
    const yaw = yawDegrees*radians, pitch = pitchDegrees*radians, roll = rollDegrees*radians;
    const f = [Math.cos(pitch)*Math.cos(yaw),Math.cos(pitch)*Math.sin(yaw),Math.sin(pitch)];
    const r = [Math.sin(yaw),-Math.cos(yaw),0], d = cross(f,r);
    const right = toPly(r.map((v,i)=>Math.cos(roll)*v+Math.sin(roll)*d[i]));
    const down = toPly(d.map((v,i)=>Math.cos(roll)*v-Math.sin(roll)*r[i]));
    const forward = toPly(f);
    const matrix = right.flatMap((_,i)=>[right[i],down[i],forward[i]]);
    const tangent = Math.tan(fov*radians/2);
    const limits = [Math.max(1.6,1.25*tangent), Math.max(1,1.25*tangent/aspect)];
    return {limits,eye:toPly([x,y,z]), right, down, forward, matrix, fov:fov*radians};
}

export function initialPose(points, count) {
    const axes = [[],[],[]];
    for (let i=0;i<count;i+=Math.max(1,Math.floor(count/4096))) {
        const j = i*4;
        if (points[j+3] < .15) continue;
        axes[0].push(points[j]);
        axes[1].push(points[j+2]);
        axes[2].push(-points[j+1]);
    }
    for (const axis of axes) axis.sort((a,b)=>a-b);
    const at = (axis,p) => axes[axis][Math.floor((axes[axis].length-1)*p)] ?? 0;
    const floor = at(2,.05), ceil = at(2,.95);
    return [at(0,.50),at(1,.50),floor+(ceil-floor)*.67,0,-7,85,0];
}

