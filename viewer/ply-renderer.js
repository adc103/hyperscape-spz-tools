const vertexShader = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
layout(location=0) in uint index;
uniform sampler2D points, scales, rotations, dc;
uniform sampler2DArray sh;
uniform int terms;
uniform vec3 eye;
uniform mat3 camera;
uniform vec2 viewport;
uniform float focal;
out vec2 delta;
flat out vec3 inverse;
flat out vec4 rgba;

vec3 rotate(vec4 q, vec3 p) {
    return p + 2.0 * cross(q.xyz, cross(q.xyz,p) + q.w*p);
}

void main() {
    ivec2 ij = ivec2(int(index & 1023u), int(index >> 10u));
    vec4 samplePoint = texelFetch(points,ij,0);
    vec3 dir = samplePoint.xyz-eye;
    vec3 center = camera*dir, scale = texelFetch(scales,ij,0).xyz;
    vec4 q = texelFetch(rotations,ij,0);
    vec3 jx, jy;
    vec2 slope = center.xy/center.z;
    for (int i=0;i<3;i++) {
        vec3 axis = vec3(0);
        axis[i] = scale[i];
        vec3 projected = camera*rotate(q, axis);
        vec2 j = (projected.xy-slope*projected.z)*(focal/center.z);
        jx[i] = j.x;
        jy[i] = j.y;
    }
    float xx=dot(jx,jx)+.3, xy=dot(jx,jy), yy=dot(jy,jy)+.3;
    vec3 area=cross(jx,jy);
    float determinant=dot(area,area)+.3*(xx+yy-.3);
    inverse=vec3(yy,-xy,xx)/determinant;
    vec2 corner=vec2((gl_VertexID & 1)==0 ? -1.0 : 1.0, (gl_VertexID & 2)==0 ? -1.0 : 1.0);
    delta=3.0*sqrt(vec2(xx,yy))*corner;
    vec2 ndc=2.0*(focal*slope+delta)/viewport;
    gl_Position=vec4(ndc.x,-ndc.y,0,1);

    vec3 n=normalize(dir);
    float x=n.x,y=n.y,z=n.z;
    float x2=x*x,y2=y*y,z2=z*z;
    float coeff[15]=float[15](
        -.4886025119*y,.4886025119*z,-.4886025119*x,
        1.0925484306*x*y,-1.0925484306*y*z,.3153915653*(2.0*z2-x2-y2),
        -1.0925484306*x*z,.5462742153*(x2-y2),
        -.5900435899*y*(3.0*x2-y2),2.8906114426*x*y*z,
        -.4570457995*y*(4.0*z2-x2-y2),.3731763326*z*(2.0*z2-3.0*x2-3.0*y2),
        -.4570457995*x*(4.0*z2-x2-y2),1.4453057213*z*(x2-y2),
        -.5900435899*x*(x2-3.0*y2));
    vec3 rgb=.5+.2820948064*texelFetch(dc,ij,0).xyz;
    for(int i=0;i<terms;i++) rgb+=coeff[i]*texelFetch(sh,ivec3(ij,i),0).xyz;
    rgba=vec4(max(rgb,vec3(0)),samplePoint.w);
}`;

const fragmentShader = `#version 300 es
precision highp float;
in vec2 delta;
flat in vec3 inverse;
flat in vec4 rgba;
out vec4 color;
void main() {
    float d=dot(delta*delta,inverse.xz)+2.0*inverse.y*delta.x*delta.y;
    float a=min(.999,rgba.a*exp(-.5*d));
    if(d>9.0 || a<1.0/255.0) discard;
    color=vec4(rgba.rgb*a,a);
}`;

const displayVertex = `#version 300 es
void main() {
    vec2 corner=vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position=vec4(corner*2.0-1.0,0,1);
}`;

const displayFragment = `#version 300 es
precision highp float;
uniform sampler2D image;
out vec4 color;
void main() { color=vec4(texelFetch(image,ivec2(gl_FragCoord.xy),0).rgb,1); }`;

function program(gl, vertex, fragment) {
    const result = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        gl.attachShader(result, shader);
        gl.deleteShader(shader);
    }
    gl.linkProgram(result);
    if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result));
    return result;
}

export function createRenderer(canvas) {
    const gl = canvas.getContext("webgl2", {alpha:false, antialias:false, depth:false, stencil:false});
    if (!gl || !gl.getExtension("EXT_color_buffer_float")) {
        throw new Error("This viewer needs WebGL 2 with floating-point color buffers.");
    }
    const splats = program(gl, vertexShader, fragmentShader);
    const display = program(gl, displayVertex, displayFragment);
    const uniform = name => gl.getUniformLocation(splats, name);
    const uniforms = Object.fromEntries(["eye","camera","viewport","focal","terms"].map(name => [name, uniform(name)]));
    const names = ["points","scales","rotations","dc","sh"];
    const vao = gl.createVertexArray();
    const indices = gl.createBuffer();
    const framebuffer = gl.createFramebuffer();
    const image = gl.createTexture();
    let textures = [];
    let imageSize = [];
    let terms = 0;

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, indices);
    gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 4, 0);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribDivisor(0, 1);
    gl.useProgram(splats);
    names.forEach((name, i) => gl.uniform1i(uniform(name), i));

    function upload(model) {
        const {width, height} = model;
        if (height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error("The PLY exceeds the GPU texture limits.");
        const incoming = [];
        names.forEach((name, i) => {
            const array = name === "sh";
            const target = array ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D;
            gl.activeTexture(gl.TEXTURE0 + i);
            const texture = gl.createTexture();
            gl.bindTexture(target, texture);
            gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            if (array) {
                gl.texImage3D(target, 0, gl.RGBA32F, width, height, Math.max(1, model.terms), 0, gl.RGBA, gl.FLOAT, model[name]);
            } else {
                gl.texImage2D(target, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, model[name]);
            }
            incoming.push(texture);
        });
        if (gl.getError() !== gl.NO_ERROR) {
            incoming.forEach(texture => gl.deleteTexture(texture));
            throw new Error("The GPU could not allocate the PLY textures.");
        }
        textures.forEach(texture => gl.deleteTexture(texture));
        textures = incoming;
        terms = model.terms;
    }

    function draw(camera, sorted) {
        const {width, height} = canvas;
        gl.viewport(0, 0, width, height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        if (imageSize[0] !== width || imageSize[1] !== height) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, image);
            gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
            gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA16F,width,height,0,gl.RGBA,gl.HALF_FLOAT,null);
            gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,image,0);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("The GPU could not allocate the render buffer.");
            imageSize = [width,height];
        }
        gl.clearColor(0,0,0,0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(splats);
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, indices);
        gl.bufferData(gl.ARRAY_BUFFER, sorted, gl.DYNAMIC_DRAW);
        textures.forEach((texture, i) => {
            gl.activeTexture(gl.TEXTURE0 + i);
            gl.bindTexture(i === 4 ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D, texture);
        });
        gl.uniform3fv(uniforms.eye, camera.eye);
        gl.uniformMatrix3fv(uniforms.camera, false, camera.matrix);
        gl.uniform2f(uniforms.viewport, width, height);
        gl.uniform1f(uniforms.focal, width / (2 * Math.tan(camera.fov / 2)));
        gl.uniform1i(uniforms.terms, terms);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, sorted.length);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.disable(gl.BLEND);
        gl.useProgram(display);
        gl.bindVertexArray(null);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, image);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    return {upload, draw};
}
