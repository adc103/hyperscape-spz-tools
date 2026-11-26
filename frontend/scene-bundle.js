import { unzipSync } from "fflate";
import { BufferAttribute, BufferGeometry, DoubleSide, LoadingManager, Ray, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshBVH } from "three-mesh-bvh";
import { init, NavMeshQuery } from "recast-navigation";
import { generateTiledNavMesh } from "recast-navigation/generators";

const sceneSize = 64 * 1024 ** 2;
const allowed = new Map([
    ["scene_mesh.glb", sceneSize], ["spawn_points_2d.json", 1024 ** 2],
    ["cluster_centroids.json", 4 * 1024 ** 2], ["od_cluster_centroids.json", 4 * 1024 ** 2],
    ["cluster_masks.bin", sceneSize], ["od_cluster_masks.bin", sceneSize],
]);
const text = new TextDecoder();

export async function readBundle(file) {
    if (!/\.zip$/i.test(file.name)) return {spz:file};
    if (file.size > 640 * 1024 ** 2) throw Error("Export ZIP is too large.");
    let budget = 0;
    const names = new Set();
    const extracted = unzipSync(new Uint8Array(await file.arrayBuffer()), {filter(entry) {
        const path = entry.name.replaceAll("\\", "/");
        if (path.split("/").includes("device_visibility_clusters")) return false;
        const name = path.split("/").at(-1);
        const limit = allowed.get(name) ?? (/\.spz$/i.test(name) ? 512 * 1024 ** 2 : 0);
        if (!limit) return false;
        const key = /\.spz$/i.test(name) ? "spz" : name;
        if (names.has(key)) throw Error("The ZIP contains duplicate scan assets.");
        names.add(key);
        budget += entry.originalSize;
        if (entry.originalSize > limit || budget > 640 * 1024 ** 2) throw Error("Export asset is too large.");
        return true;
    }});
    const files = new Map();
    for (const [path, bytes] of Object.entries(extracted)) {
        const name = path.replaceAll("\\", "/").split("/").at(-1);
        const key = /\.spz$/i.test(name) ? "spz" : name;
        if (files.has(key)) throw Error("The ZIP contains duplicate scan assets.");
        files.set(key, bytes);
    }
    const spz = files.get("spz");
    if (!spz) throw Error("The export ZIP needs one SPZ.");
    const json = name => files.has(name) ? JSON.parse(text.decode(files.get(name))) : undefined;
    const mesh = files.get("scene_mesh.glb");
    return {
        spz: new Blob([spz]),
        mesh: mesh?.buffer.slice(mesh.byteOffset, mesh.byteOffset+mesh.byteLength),
        spawn: json("spawn_points_2d.json") ?? [],
        clusters: json("cluster_centroids.json") ?? json("od_cluster_centroids.json"),
        masks: files.get("cluster_masks.bin") ?? files.get("od_cluster_masks.bin"),
    };
}

function navCoordinates([x,y,z]) { return {x, y:z, z:-y}; }
function modelCoordinates({x,y,z}) { return [x,-z,y]; }

export async function buildMeshNavigation(bytes, spawn, clusters) {
    const manager = new LoadingManager();
    manager.setURLModifier(url => {
        if (!/^(blob:|data:)/i.test(url)) throw Error("The GLB refers to an external asset.");
        return url;
    });
    const {scene} = await new GLTFLoader(manager).parseAsync(bytes, "");
    scene.updateMatrixWorld(true);
    const positions = [], indices = [];
    const xyz = new Vector3();
    scene.traverse(item => {
        if (!item.isMesh) return;
        const geometry = item.geometry;
        const position = geometry.getAttribute("position");
        if (!position || position.itemSize !== 3) return;
        const offset = positions.length/3;
        for (let i=0; i<position.count; i++) {
            xyz.fromBufferAttribute(position, i).applyMatrix4(item.matrixWorld);
            positions.push(xyz.x, xyz.y, xyz.z);
        }
        const index = geometry.getIndex();
        const count = index?.count ?? position.count;
        if (count % 3) throw Error("The GLB needs triangle geometry.");
        const flip = item.matrixWorld.determinant() < 0;
        for (let i=0; i<count; i+=3) {
            const a=index?index.getX(i):i, b=index?index.getX(i+1):i+1, c=index?index.getX(i+2):i+2;
            indices.push(offset+a, offset+(flip?c:b), offset+(flip?b:c));
        }
    });
    if (!indices.length || positions.some(x=>!Number.isFinite(x))) throw Error("Invalid GLB scene geometry.");
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    for (let i=0; i<positions.length; i+=3) {
        minX=Math.min(minX,positions[i]); maxX=Math.max(maxX,positions[i]);
        minY=Math.min(minY,positions[i+1]); maxY=Math.max(maxY,positions[i+1]);
    }
    if (Math.max(maxX-minX,maxY-minY)>250) throw Error("The mesh is too large for teleport navigation.");
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(Float32Array.from(positions), 3));
    geometry.setIndex(new BufferAttribute(Uint32Array.from(indices), 1));
    const bvh = new MeshBVH(geometry, {indirect:true});
    const yUp = new Float32Array(positions.length);
    for (let i=0; i<positions.length; i+=3) {
        yUp[i]=positions[i]; yUp[i+1]=positions[i+2]; yUp[i+2]=-positions[i+1];
    }
    await init();
    const built = generateTiledNavMesh(yUp, indices, {
        cs:.2, ch:.02, tileSize:256, walkableSlopeAngle:5.5,
        walkableHeight:100, walkableClimb:2, walkableRadius:2,
        minRegionArea:4, mergeRegionArea:12,
    });
    if (!built.success) {
        geometry.dispose();
        throw Error("Could not build a walkable surface from the GLB.");
    }
    const navMesh = built.navMesh;
    const query = new NavMeshQuery(navMesh);
    const ray = new Ray();
    const start = new Vector3(), end = new Vector3();
    function raycast(from, to) {
        start.fromArray(from); end.fromArray(to);
        ray.origin.copy(start);
        ray.direction.subVectors(end, start);
        const distance = ray.direction.length();
        if (distance < .002) return null;
        ray.direction.multiplyScalar(1/distance);
        const hit = bvh.raycastFirst(ray, DoubleSide, .002, distance);
        return hit ? {point:hit.point.toArray(), normal:hit.face.normal.toArray()} : null;
    }
    function nearest(point, halfExtents) {
        return query.findClosestPoint(navCoordinates(point), {halfExtents});
    }
    function landing(point) {
        const hit = nearest(point, {x:.10,y:.18,z:.10});
        if (!hit.success || !hit.polyRef) return null;
        const target = modelCoordinates(hit.point);
        if (!hit.isPointOverPoly && Math.hypot(point[0]-target[0],point[1]-target[1]) > .012) return null;
        return target;
    }
    function startAt(eye) {
        const candidates = Array.isArray(spawn) ? spawn.filter(p=>p && Number.isFinite(p.x) && Number.isFinite(p.y)) : [];
        const positions = candidates.map(p=>[p.x,p.y,eye[2]]);
        positions.sort((a,b)=>Math.hypot(a[0]-eye[0],a[1]-eye[1])-Math.hypot(b[0]-eye[0],b[1]-eye[1]));
        positions.push(eye);
        const views = clusters?.views ?? [];
        for (const guess of positions) {
            const closest = views.reduce((best,v)=>!best || Math.hypot(v[0]-guess[0],v[1]-guess[1]) <
                Math.hypot(best[0]-guess[0],best[1]-guess[1]) ? v : best, null);
            const height = closest?.[2] ?? guess[2];
            const floor = raycast([guess[0],guess[1],height], [guess[0],guess[1],height-2.6]);
            if (!floor || floor.normal[2] < .5) continue;
            const hit = nearest(floor.point,{x:.5,y:.2,z:.5});
            if (hit.success && hit.polyRef) return modelCoordinates(hit.point);
        }
        return null;
    }
    return {raycast, landing, startAt, destroy() { query.destroy(); navMesh.destroy(); geometry.dispose(); }};
}

export function visibilityOf(bundle, count) {
    const {clusters,masks} = bundle;
    if (!clusters || !masks) return null;
    const views = clusters.views;
    if (clusters.splat_count !== count || !Array.isArray(views) || !views.length ||
        !views.every(v=>Array.isArray(v) && v.length===3 && v.every(Number.isFinite)) ||
        masks.length !== 4*Math.ceil(views.length*count/32)) {
        throw Error("The visibility files do not match the SPZ.");
    }
    return {views,masks};
}
