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
