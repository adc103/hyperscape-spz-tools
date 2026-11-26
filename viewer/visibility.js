'use strict';

function visibilityOffset(visibility, eye, count) {
    if (!visibility) return -1;
    let selected=0, distance=Infinity;
    for (let i=0; i<visibility.views.length; i++) {
        const v=visibility.views[i];
        const d=(v[0]-eye[0])**2+(v[1]-eye[1])**2+(v[2]-eye[2])**2;
        if (d<distance) { distance=d; selected=i; }
    }
    return selected*count;
}

function visibleInCluster(visibility, offset, index) {
    if (offset<0) return true;
    const bit=offset+index;
    return (visibility.masks[Math.floor(bit/8)] & (1<<(bit%8)))!==0;
}
