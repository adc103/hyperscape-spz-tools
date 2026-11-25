#include <algorithm>
#include <cmath>
#include <vector>
struct ViewSplat {
    float x,y,xx,xy,yy,r,g,b;
};
struct Footprint {
    float a,b,c,ex,ey,inv00,inv01,inv11,opacity;
};
extern "C" void raster_fit(int count,const ViewSplat* data,const int* ids,
    int w,int h,const float* log_scale,const float* alpha,
    const float* target,float* out,float* grad_scale,float* grad_alpha) {
    std::vector<Footprint> footprints(count);
    for(int i=0;i<count;i++) {
        const auto& s=data[i];
        const float size=std::exp(2*log_scale[ids[i]]);
        const float a=s.xx*size+.3f,b=s.xy*size,c=s.yy*size+.3f;
        const float inv=1/(a*c-b*b);
        footprints[i]={a,b,c,3*std::sqrt(a),3*std::sqrt(c),c*inv,-b*inv,a*inv,alpha[ids[i]]};
    }
    // Render front to back. Replay the same blend in the backward pass so we
    // can recover the contribution of later splats without storing pixel lists.
    for(int pass=0;pass<(target?2:1);pass++) {
        std::vector<float> prefix;
        if(pass) {
            prefix.resize(w*h*4);
            for(int i=0;i<w*h;i++)prefix[i*4+3]=1;
        }
        for(int i=0;i<count;i++) {
            const auto& f=footprints[i];const auto& s=data[i];const int id=ids[i];
            float ga=0,gs=0;
            const int x0=std::max(0,int(std::ceil(s.x-f.ex))), x1=std::min(w-1,int(std::floor(s.x+f.ex)));
            const int y0=std::max(0,int(std::ceil(s.y-f.ey))), y1=std::min(h-1,int(std::floor(s.y+f.ey)));
            for(int y=y0;y<=y1;y++)for(int x=x0;x<=x1;x++) {
                const int k=(y*w+x)*4;
                float* p=(pass?prefix.data():out)+k;
                const float trans=p[3];
                if(trans<.001f)continue;
                const float dx=x-s.x,dy=y-s.y;
                const float u=f.inv00*dx+f.inv01*dy,v=f.inv01*dx+f.inv11*dy;
                const float d=u*dx+v*dy;
                if(d>9)continue;
                const float kernel=std::exp(-.5f*d),a=std::min(.999f,f.opacity*kernel);
                const float color[]={s.r,s.g,s.b};
                if(a<1.f/255)continue;
                float weight=0;
                for(int channel=0;channel<3;channel++) {
                    p[channel]+=trans*a*color[channel];
                    if(pass) {
                        const float residual=out[k+channel]-target[k+channel];
                        const float image_grad=std::clamp(residual,-.08f,.08f);
                        // The part after this splat is attenuated by (1-a).
                        weight+=image_grad*(trans*color[channel]-(out[k+channel]-p[channel])/(1-a));
                    }
                }
                p[3]*=1-a;
                if(pass) {
                    ga+=weight*kernel;
                    gs+=weight*a*(d-.3f*(u*u+v*v));
                }
            }
            if(pass) {grad_alpha[id]+=ga;grad_scale[id]+=gs;}
        }
    }
}

// RayQuadratic reference rasterization, using precomputed view-space support.
extern "C" void draw_native_quad(int count, const float* splats, int w, int h, float focal, float* output) {
    for (int i=0; i<count; ++i) {
        const float* s=splats+i*19;
        const int left=std::max(0,(int)std::ceil(s[0]));
        const int right=std::min(w-1,(int)std::floor(s[1]));
        const int top=std::max(0,(int)std::ceil(s[2]));
        const int bottom=std::min(h-1,(int)std::floor(s[3]));
        for (int y=top; y<=bottom; ++y) {
            const float py=(y+.5f-h*.5f)/focal;
            for (int x=left; x<=right; ++x) {
                float* pixel=output+4*(y*w+x);
                if (pixel[3]<.001f) continue;
                const float px=(x+.5f-w*.5f)/focal;
                const float a=s[8]*px+s[9]*py+s[10];
                const float b=s[11]*px+s[12]*py+s[13];
                const float z=s[14]*px+s[15]*py+s[16];
                if (z<=0 || std::abs(a)>s[17]*z || std::abs(b)>s[17]*z) continue;
                const float uvSquared=(a*a+b*b)/(z*z);
                const float opacity=s[4]*(1-uvSquared/(1+s[18]*uvSquared)/9);
                if (opacity<1.f/255) continue;
                for (int k=0;k<3;++k) pixel[k]+=pixel[3]*opacity*s[5+k];
                pixel[3]*=1-opacity;
            }
        }
    }
}
struct RefineSplat {
    float x, y, jx[3], jy[3], r, g, b;
};

struct Projected {
    float x, y, vx[3], vy[3], inv00, inv01, inv11, ex, ey, rgb[3];
};

// Each parameter row contains three log-scale offsets, opacity, three position
// offsets in local splat units, and three view-space RGB offsets.
extern "C" void raster_refine(int count, const RefineSplat* data, int w, int h,
    const float* params, const float* target, float* out, float* gradient,
    float filter, float cutoff, float support, float clip_error) {
    std::vector<Projected> footprints(count);
    for (int i = 0; i < count; ++i) {
        const auto& splat = data[i];
        const float* p = params + 10*i;
        auto& projected = footprints[i];
        projected.x = splat.x;
        projected.y = splat.y;
        float xx = filter, xy = 0, yy = filter;
        for (int axis = 0; axis < 3; ++axis) {
            const float size = std::exp(p[axis]);
            const float vx = projected.vx[axis] = splat.jx[axis]*size;
            const float vy = projected.vy[axis] = splat.jy[axis]*size;
            xx += vx*vx;
            xy += vx*vy;
            yy += vy*vy;
            projected.x += splat.jx[axis]*p[4+axis];
            projected.y += splat.jy[axis]*p[4+axis];
        }
        float determinant = xx*yy-xy*xy;
        if (determinant <= 1e-5f*xx*yy) {
            // The expanded Gram determinant is stable for long, thin splats.
            determinant = filter*(xx+yy-filter);
            for (int j = 0; j < 3; ++j) {
                for (int k = j+1; k < 3; ++k) {
                    const float minor = projected.vx[j]*projected.vy[k]-projected.vx[k]*projected.vy[j];
                    determinant += minor*minor;
                }
            }
        }
        const float inv = 1/determinant;
        projected.inv00 = yy*inv;
        projected.inv01 = -xy*inv;
        projected.inv11 = xx*inv;
        projected.ex = std::sqrt(support*xx);
        projected.ey = std::sqrt(support*yy);
        projected.rgb[0] = std::max(0.f,splat.r+p[7]);
        projected.rgb[1] = std::max(0.f,splat.g+p[8]);
        projected.rgb[2] = std::max(0.f,splat.b+p[9]);
    }

    // Replay blending to recover the color behind each contribution during
    // differentiation. Only two framebuffer-sized buffers are needed.
    std::vector<float> prefix;
    if (target) {
        prefix.resize(w*h*4);
        for (int i = 0; i < w*h; ++i) prefix[i*4+3] = 1;
    }
    for (int pass = 0; pass < (target ? 2 : 1); ++pass) {
        for (int i = 0; i < count; ++i) {
            const auto& f = footprints[i];
            const auto& splat = data[i];
            const float* p = params+10*i;
            float g[10] = {};
            const int x0 = std::max(0,int(std::ceil(f.x-f.ex)));
            const int x1 = std::min(w-1,int(std::floor(f.x+f.ex)));
            const int y0 = std::max(0,int(std::ceil(f.y-f.ey)));
            const int y1 = std::min(h-1,int(std::floor(f.y+f.ey)));
            for (int y = y0; y <= y1; ++y) {
                for (int x = x0; x <= x1; ++x) {
                    const int k = (y*w+x)*4;
                    float* pixel = (pass ? prefix.data() : out)+k;
                    const float transmittance = pixel[3];
                    if (transmittance < .001f) continue;
                    const float dx = x-f.x, dy = y-f.y;
                    const float u = f.inv00*dx+f.inv01*dy;
                    const float v = f.inv01*dx+f.inv11*dy;
                    const float d = u*dx+v*dy;
                    if (d > support) continue;
                    const float kernel = std::exp(-.5f*d);
                    const float alpha = std::min(.999f,p[3]*kernel);
                    if (alpha < cutoff) continue;
                    const float contribution = transmittance*alpha;
                    float opacity_gradient = 0;
                    for (int channel = 0; channel < 3; ++channel) {
                        pixel[channel] += contribution*f.rgb[channel];
                        if (pass) {
                            const float residual = std::min(out[k+channel],1.f)-target[k+channel];
                            const float image_gradient = std::clamp(residual,-clip_error,clip_error)
                                *(out[k+channel] > 1.f && residual > 0 ? .1f : 1.f);
                            const float behind = (out[k+channel]-pixel[channel])/(1-alpha);
                            opacity_gradient += image_gradient*(transmittance*f.rgb[channel]-behind);
                            if (f.rgb[channel] > 0 || image_gradient < 0)
                                g[7+channel] += image_gradient*contribution;
                        }
                    }
                    pixel[3] *= 1-alpha;
                    if (pass) {
                        g[3] += opacity_gradient*kernel;
                        for (int axis = 0; axis < 3; ++axis) {
                            const float direction = f.vx[axis]*u+f.vy[axis]*v;
                            g[axis] += opacity_gradient*alpha*direction*direction;
                            g[4+axis] += opacity_gradient*alpha*(splat.jx[axis]*u+splat.jy[axis]*v);
                        }
                    }
                }
            }
            if (pass) std::copy(g,g+10,gradient+10*i);
        }
    }
}
