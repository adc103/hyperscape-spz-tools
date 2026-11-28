#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <thread>
#include <vector>

// Split the image into horizontal bands and spread them over threads. A pixel is
// only touched by its own band, so blending needs no locks. Each thread handles
// bands t, t+T, t+2T, ... and keeps its own gradient sums, so results are
// deterministic for a given thread count.
static int thread_count(int h) {
    const char* env = std::getenv("HYPERSCAPE_THREADS");
    int threads = env ? std::atoi(env) : int(std::thread::hardware_concurrency());
    return std::max(1, std::min({threads, 64, std::max(1, h/16)}));
}

template <class Work>
static void run_bands(int h, int threads, Work work) {
    const int bands = threads*4;
    auto run = [&](int t) {
        for (int band = t; band < bands; band += threads)
            work(t, h*band/bands, h*(band+1)/bands);
    };
    if (threads == 1) { run(0); return; }
    std::vector<std::thread> pool;
    for (int t = 1; t < threads; ++t) pool.emplace_back(run, t);
    run(0);
    for (auto& thread : pool) thread.join();
}

// Pixels a splat can reach: d = [dx dy] M [dx dy]^T <= limit, where M holds the
// inverse covariance. limit already accounts for the opacity cutoff, so pixels
// outside it would be discarded anyway. A small margin keeps rounding identical.
static inline float reach(float opacity, float cutoff, float support) {
    if (!(opacity > cutoff)) return -1;
    return std::min(support, 2*std::log(opacity/cutoff))*1.001f+1e-3f;
}
static inline float row_extent(float limit, float i00, float i01, float i11) {
    const float det = i00*i11-i01*i01;
    return limit > 0 && det > 0 ? std::sqrt(limit*i00/det) : -1;
}
static inline bool row_span(float dy, float cx, float limit, float i00, float i01, float i11, int w, int& x0, int& x1) {
    const float b = i01*dy;
    const float disc = b*b-i00*(i11*dy*dy-limit);
    if (disc < 0 || i00 <= 0) return false;
    const float r = std::sqrt(disc);
    x0 = std::max(0, int(std::ceil(cx+(-b-r)/i00)));
    x1 = std::min(w-1, int(std::floor(cx+(-b+r)/i00)));
    return x0 <= x1;
}

// Count still-visible pixels per 16x16 tile inside one band, so a splat whose
// whole footprint is already covered can be skipped without visiting pixels.
struct TileCoverage {
    int x_tiles = 0, y0 = 0, y1 = 0;
    std::vector<int> alive;
    void reset(int w, int band0, int band1) {
        x_tiles = (w+15)/16; y0 = band0; y1 = band1;
        alive.assign(size_t(x_tiles)*((band1-band0+15)/16), 0);
        for (int y = band0; y < band1; ++y)
            for (int tx = 0; tx < x_tiles; ++tx)
                alive[size_t((y-band0)/16)*x_tiles+tx] += std::min(16, w-tx*16);
    }
    bool any(int x0, int x1, int ya, int yb) const {
        for (int ty = (ya-y0)/16; ty <= (yb-y0)/16; ++ty)
            for (int tx = x0/16; tx <= x1/16; ++tx)
                if (alive[size_t(ty)*x_tiles+tx]) return true;
        return false;
    }
    void covered(int x, int y) { --alive[size_t((y-y0)/16)*x_tiles+x/16]; }
};
static inline float column_extent(float limit, float i00, float i01, float i11) {
    const float det = i00*i11-i01*i01;
    return limit > 0 && det > 0 ? std::sqrt(limit*i11/det) : -1;
}

struct ViewSplat {
    float x,y,xx,xy,yy,r,g,b;
};
struct Footprint {
    float a,b,c,ex,ey,inv00,inv01,inv11,opacity,limit;
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
        const float limit=reach(alpha[ids[i]],1.f/255,9);
        footprints[i]={a,b,c,3*std::sqrt(a),0,c*inv,-b*inv,a*inv,alpha[ids[i]],limit};
        footprints[i].ey=row_extent(limit,footprints[i].inv00,footprints[i].inv01,footprints[i].inv11);
    }
    // Render front to back. Replay the same blend in the backward pass so we
    // can recover the contribution of later splats without storing pixel lists.
    const int threads = thread_count(h);
    std::vector<float> prefix;
    if (target) {
        prefix.resize(size_t(w)*h*4);
        for (int i=0;i<w*h;i++) prefix[i*4+3]=1;
    }
    std::vector<float> sums(target ? size_t(threads)*count*2 : 0);
    run_bands(h, threads, [&](int t, int band0, int band1) {
        float* thread_sums = target ? sums.data()+size_t(t)*count*2 : nullptr;
        TileCoverage tiles;
        for(int pass=0;pass<(target?2:1);pass++) {
            tiles.reset(w,band0,band1);
            for(int i=0;i<count;i++) {
                const auto& f=footprints[i];const auto& s=data[i];
                if(f.ey<0)continue;
                const int y0=std::max(band0,int(std::ceil(s.y-f.ey))), y1=std::min(band1-1,int(std::floor(s.y+f.ey)));
                if(y0>y1)continue;
                const float ex=column_extent(f.limit,f.inv00,f.inv01,f.inv11);
                const int bx0=std::max(0,int(std::floor(s.x-ex))-1), bx1=std::min(w-1,int(std::ceil(s.x+ex))+1);
                if(bx0>bx1||!tiles.any(bx0,bx1,y0,y1))continue;
                float ga=0,gs=0;
                for(int y=y0;y<=y1;y++){int x0,x1;if(!row_span(y-s.y,s.x,f.limit,f.inv00,f.inv01,f.inv11,w,x0,x1))continue;for(int x=x0;x<=x1;x++) {
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
                    if(p[3]<.001f)tiles.covered(x,y);
                    if(pass) {
                        ga+=weight*kernel;
                        gs+=weight*a*(d-.3f*(u*u+v*v));
                    }
                }}
                if(pass) {thread_sums[2*i]+=ga;thread_sums[2*i+1]+=gs;}
            }
        }
    });
    if (target) {
        for (int t=0;t<threads;t++) {
            const float* thread_sums=sums.data()+size_t(t)*count*2;
            for (int i=0;i<count;i++) {
                grad_alpha[ids[i]]+=thread_sums[2*i];
                grad_scale[ids[i]]+=thread_sums[2*i+1];
            }
        }
    }
}

// RayQuadratic reference rasterization, using precomputed view-space support.
extern "C" void draw_native_quad(int count, const float* splats, int w, int h, float focal, float* output) {
    run_bands(h, thread_count(h), [&](int, int band0, int band1) {
    for (int i=0; i<count; ++i) {
        const float* s=splats+i*19;
        const int top=std::max(band0,(int)std::ceil(s[2]));
        const int bottom=std::min(band1-1,(int)std::floor(s[3]));
        if (top>bottom) continue;
        const int left=std::max(0,(int)std::ceil(s[0]));
        const int right=std::min(w-1,(int)std::floor(s[1]));
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
    });
}
struct RefineSplat {
    float x, y, jx[3], jy[3], r, g, b;
};

struct Projected {
    float x, y, vx[3], vy[3], inv00, inv01, inv11, ex, ey, limit, rgb[3];
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
        projected.limit = reach(p[3], cutoff, support);
        projected.ex = std::sqrt(support*xx);
        projected.ey = row_extent(projected.limit, projected.inv00, projected.inv01, projected.inv11);
        projected.rgb[0] = std::max(0.f,splat.r+p[7]);
        projected.rgb[1] = std::max(0.f,splat.g+p[8]);
        projected.rgb[2] = std::max(0.f,splat.b+p[9]);
    }

    // Replay blending to recover the color behind each contribution during
    // differentiation. Only two framebuffer-sized buffers are needed.
    std::vector<float> prefix;
    if (target) {
        prefix.resize(size_t(w)*h*4);
        for (int i = 0; i < w*h; ++i) prefix[i*4+3] = 1;
    }
    const int threads = thread_count(h);
    std::vector<float> sums(target ? size_t(threads)*count*10 : 0);
    run_bands(h, threads, [&](int t, int band0, int band1) {
    float* thread_sums = target ? sums.data()+size_t(t)*count*10 : nullptr;
    TileCoverage tiles;
    for (int pass = 0; pass < (target ? 2 : 1); ++pass) {
        tiles.reset(w, band0, band1);
        for (int i = 0; i < count; ++i) {
            const auto& f = footprints[i];
            if (f.ey < 0) continue;
            const int y0 = std::max(band0,int(std::ceil(f.y-f.ey)));
            const int y1 = std::min(band1-1,int(std::floor(f.y+f.ey)));
            if (y0 > y1) continue;
            const float ex = column_extent(f.limit, f.inv00, f.inv01, f.inv11);
            const int bx0 = std::max(0,int(std::floor(f.x-ex))-1), bx1 = std::min(w-1,int(std::ceil(f.x+ex))+1);
            if (bx0 > bx1 || !tiles.any(bx0, bx1, y0, y1)) continue;
            const auto& splat = data[i];
            const float* p = params+10*i;
            float g[10] = {};
            for (int y = y0; y <= y1; ++y) {
                int x0, x1;
                if (!row_span(y-f.y, f.x, f.limit, f.inv00, f.inv01, f.inv11, w, x0, x1)) continue;
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
                    if (pixel[3] < .001f) tiles.covered(x, y);
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
            if (pass) for (int j = 0; j < 10; ++j) thread_sums[10*i+j] += g[j];
        }
    }
    });
    if (target) {
        std::fill(gradient, gradient+size_t(count)*10, 0.f);
        for (int t = 0; t < threads; ++t) {
            const float* thread_sums = sums.data()+size_t(t)*count*10;
            for (size_t j = 0; j < size_t(count)*10; ++j) gradient[j] += thread_sums[j];
        }
    }
}
