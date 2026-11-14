import * as THREE from './vendor/three.module.js';
import { makeCatSkin } from './cat-skin.js';
import { foxtailJumpAction, foxtailJumpHeight, foxtailJumpWindow, planFoxtailJumps } from './foxtail-jump.js';
import { buildSummerFlight } from './summer-flight.js';

// Four revolutions make a year. The geometry stays still; the seasons pass over it.
const SETTINGS = {
  radius: 5.4,
  hubRadius: .96,
  blades: matchMedia('(max-width: 700px)').matches ? 84000 : 196000,
  flowers: 12500,
  particles: 2640,
  snowflakes: matchMedia('(max-width: 700px)').matches ? 1660 : 3800,
  grassHeight: 1.5,
  grassRecoverySeconds: 1.2,
  snowPrintSeconds: 14,
  yearSeconds: 112,
  initialPhase: .87,
  seed: 713821,
};
const TAU = Math.PI * 2;
const phaseRate=4/SETTINGS.yearSeconds;
const MAX_FRAME_SECONDS=.065;
const stage = document.querySelector('.stage');
const canvas = document.querySelector('#scene');
const loading = document.querySelector('.loading');
const status = document.querySelector('#status');
const timeline = document.querySelector('#timeline');
const play = document.querySelector('#play');
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const seasonNames = ['春生', '夏长', '秋收', '冬藏'];
const seasonEnglish = ['SPRING', 'SUMMER', 'AUTUMN', 'WINTER'];
const seasonButtons = [...document.querySelectorAll('[data-season]')];
let phase = SETTINGS.initialPhase, time = 0, speed = 1;
let needlePhaseOffset=phase;
let requestedSpeed=1, catTimeOffset=0, timelapse=null;
let firstFoxtailPlan=-Infinity;
let paused = motionPreference.matches, ready = false, previousTime = 0;
let lastSeason = -1, lastUiUpdate = 0;
let randomState = SETTINGS.seed;
const random = () => {
  randomState |= 0;
  randomState = randomState + 0x6D2B79F5 | 0;
  let t = Math.imul(randomState ^ randomState >>> 15, 1 | randomState);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};
const between = (a, b) => a + (b - a) * random();

// RGB stores grass pressure and lay direction. Alpha stores snow impressions,
// which fill in much more slowly than grass springs back.
function createTrampleField() {
  const size=256, extent=SETTINGS.radius*2+.6;
  const values=new Float32Array(size*size*4);
  const pixels=new Uint8Array(size*size*4);
  const texture=new THREE.DataTexture(pixels,size,size,THREE.RGBAFormat);
  texture.minFilter=texture.magFilter=THREE.LinearFilter;
  texture.generateMipmaps=false;
  let bounds;
  function clear() {
    values.fill(0); pixels.fill(0);
    for(let i=0;i<size*size;i++) {
      pixels[i*4+1]=pixels[i*4+2]=128;
    }
    bounds={left:size,right:-1,top:size,bottom:-1};
  }
  function decay(dt) {
    const factor=Math.exp(-dt/SETTINGS.grassRecoverySeconds);
    const snowFactor=Math.exp(-dt/SETTINGS.snowPrintSeconds);
    for(let y=bounds.top;y<=bounds.bottom;y++)for(let x=bounds.left;x<=bounds.right;x++) {
      const i=(y*size+x)*4;
      values[i]*=factor; values[i+1]*=factor; values[i+2]*=factor;
      values[i+3]*=snowFactor;
    }
  }
  function stamp(x,z,headingX,headingZ,length,width,force,snow=false) {
    if(force<.015)return;
    const radius=Math.max(length,width)*1.95;
    const left=Math.max(0,Math.floor(((x-radius)/extent+.5)*size));
    const right=Math.min(size-1,Math.ceil(((x+radius)/extent+.5)*size));
    const top=Math.max(0,Math.floor(((z-radius)/extent+.5)*size));
    const bottom=Math.min(size-1,Math.ceil(((z+radius)/extent+.5)*size));
    bounds.left=Math.min(bounds.left,left); bounds.right=Math.max(bounds.right,right);
    bounds.top=Math.min(bounds.top,top); bounds.bottom=Math.max(bounds.bottom,bottom);
    for(let y=top;y<=bottom;y++)for(let col=left;col<=right;col++) {
      const dx=((col+.5)/size-.5)*extent-x, dz=((y+.5)/size-.5)*extent-z;
      const along=(dx*headingX+dz*headingZ)/length;
      const across=(-dx*headingZ+dz*headingX)/width;
      const distance=along*along+across*across;
      if(distance>3.8)continue;
      const pressure=force*Math.exp(-1.20*distance);
      const i=(y*size+col)*4;
      if(snow) {
        values[i+3]=Math.max(values[i+3],pressure);
        continue;
      }
      if(pressure<=values[i])continue;
      values[i]=pressure;
      // Lay the tips away from the footprint, with a little drag in the stride direction.
      values[i+1]=pressure*(dx/radius*.95+headingX*.18);
      values[i+2]=pressure*(dz/radius*.95+headingZ*.18);
    }
  }
  function upload() {
    for(let y=bounds.top;y<=bounds.bottom;y++)for(let x=bounds.left;x<=bounds.right;x++) {
      const i=(y*size+x)*4;
      pixels[i]=Math.round(Math.min(1,values[i])*255);
      pixels[i+1]=Math.round(128+THREE.MathUtils.clamp(values[i+1],-1,1)*127);
      pixels[i+2]=Math.round(128+THREE.MathUtils.clamp(values[i+2],-1,1)*127);
      pixels[i+3]=Math.round(values[i+3]*255);
    }
    texture.needsUpdate=true;
  }
  function sample(x,z) {
    const col=THREE.MathUtils.clamp(Math.floor((x/extent+.5)*size),0,size-1);
    const row=THREE.MathUtils.clamp(Math.floor((z/extent+.5)*size),0,size-1);
    return values[(row*size+col)*4];
  }
  clear(); texture.needsUpdate=true;
  return {texture,extent,clear,decay,stamp,upload,sample};
}
const trampleField=createTrampleField();

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
} catch (error) {
  loading.textContent = '当前浏览器无法启用 3D 图形，请开启硬件加速后重新打开。';
  document.querySelectorAll('.controls button, .controls input, .controls select, .fullscreen').forEach(el => el.disabled = true);
  throw error;
}
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.info.autoReset = false;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(27.5, 16 / 9, .1, 110);
camera.position.set(0, 9.5, 14.8);
camera.lookAt(0, .10, 0);

function makeAtmospherePass() {
  const screen = new THREE.Scene();
  const screenCamera = new THREE.Camera();
  const uniforms = {
    uFrame: { value: null },
    uCatMask: { value: null },
    uCatBloom: { value: null },
    uPixel: { value: new THREE.Vector2() },
    uAspect: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms, depthTest: false, depthWrite: false, toneMapped: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv=uv;
        gl_Position=vec4(position.xy,0.,1.);
      }`,
    fragmentShader: `
      uniform sampler2D uFrame;
      uniform sampler2D uCatMask;
      uniform sampler2D uCatBloom;
      uniform vec2 uPixel;
      uniform float uAspect;
      varying vec2 vUv;
      const vec3 luma=vec3(.2126,.7152,.0722);

      vec3 haloSource(vec2 uv) {
        vec3 color=texture2D(uFrame,uv).rgb;
        float glow=smoothstep(.47,.86,dot(color,luma));
        float gold=smoothstep(.08,.29,color.r-color.b);
        return color*glow*mix(.12,1.,gold);
      }

      void main() {
        // The framebuffer already contains display-space colors.
        vec3 color=texture2D(uFrame,vUv).rgb;
        float light=dot(color,luma);
        float shadow=1.-smoothstep(.08,.46,light);
        float highlight=smoothstep(.28,.78,light);
        float warmth=smoothstep(.035,.19,color.r-color.b)*highlight;
        color=mix(color,vec3(light),.075*(1.-highlight));
        color+=vec3(-.009,.004,.014)*shadow*smoothstep(0.,.085,light);
        color*=mix(vec3(1.),vec3(1.035,1.012,.975),warmth);

        vec2 spread=uPixel*max(3.,.0065/uPixel.x);
        vec3 glow=haloSource(vUv+spread)+haloSource(vUv-spread)
          +haloSource(vUv+vec2(spread.x,-spread.y))+haloSource(vUv+vec2(-spread.x,spread.y));
        color+=glow*.042;

        vec2 mask=texture2D(uCatMask,vUv).rg;
        vec2 bloom=texture2D(uCatBloom,vUv).rg;
        vec2 halo=(1.-exp(-2.4*bloom))*(1.-mask);
        vec3 aura=halo.r*vec3(.53,.73,1.)+halo.g*vec3(1.,.85,.59);
        color+=aura*(1.-color)*1.18;
        color=mix(color,vec3(.71,.84,1.),halo.r*.12);
        color=mix(color,vec3(1.,.93,.77),halo.g*.16);

        vec2 edge=(vUv-vec2(.5,.42))*vec2(min(uAspect,1.8)*.68,1.);
        color*=1.-.24*smoothstep(.29,.71,length(edge));
        vec2 pixel=floor(gl_FragCoord.xy);
        float grain=fract(52.9829189*fract(dot(pixel,vec2(.06711056,.00583715))))-.5;
        color+=grain*.011*smoothstep(.015,.17,light)*(1.-.72*highlight);
        gl_FragColor=vec4(clamp(color,0.,1.),1.);
      }`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);
  quad.frustumCulled=false;
  screen.add(quad);
  const horizontal=new THREE.WebGLRenderTarget(1,1,{depthBuffer:false});
  const vertical=new THREE.WebGLRenderTarget(1,1,{depthBuffer:false});
  uniforms.uCatBloom.value=vertical.texture;
  const blur=new THREE.ShaderMaterial({
    uniforms:{uSource:{value:null},uStep:{value:new THREE.Vector2()}},
    vertexShader:material.vertexShader,depthTest:false,depthWrite:false,toneMapped:false,
    fragmentShader:`
      uniform sampler2D uSource;
      uniform vec2 uStep;
      varying vec2 vUv;
      void main() {
        // Adjacent Gaussian taps are paired with bilinear filtering.
        vec4 color=texture2D(uSource,vUv)*.150733;
        color+=(texture2D(uSource,vUv+uStep*1.446802)+texture2D(uSource,vUv-uStep*1.446802))*.253750;
        color+=(texture2D(uSource,vUv+uStep*3.377917)+texture2D(uSource,vUv-uStep*3.377917))*.127663;
        color+=(texture2D(uSource,vUv+uStep*5.313631)+texture2D(uSource,vUv-uStep*5.313631))*.037035;
        color+=(texture2D(uSource,vUv+uStep*7.255784)+texture2D(uSource,vUv-uStep*7.255784))*.006185;
        gl_FragColor=color;
      }`,
  });
  const maskMaterials=[
    new THREE.MeshBasicMaterial({color:0xff0000,toneMapped:false,depthWrite:false}),
    new THREE.MeshBasicMaterial({color:0x00ff00,toneMapped:false,depthWrite:false}),
  ];
  const catMeshes=[];

  return {
    resize(width,height) {
      if(!width||!height)return;
      const frame=uniforms.uFrame.value;
      if(frame?.image.width===width&&frame.image.height===height)return;
      frame?.dispose();
      uniforms.uFrame.value=new THREE.FramebufferTexture(width,height);
      uniforms.uCatMask.value?.dispose();
      uniforms.uCatMask.value=new THREE.FramebufferTexture(width,height);
      uniforms.uCatMask.value.minFilter=uniforms.uCatMask.value.magFilter=THREE.LinearFilter;
      const scale=Math.min(.5,640/width);
      horizontal.setSize(Math.ceil(width*scale),Math.ceil(height*scale));
      vertical.setSize(horizontal.width,horizontal.height);
      uniforms.uPixel.value.set(1/width,1/height);
      uniforms.uAspect.value=width/height;
    },
    addCat(root,index) {
      root.traverse(object=>{
        if(!object.isMesh||!object.visible||object.material.transparent)return;
        object.layers.enable(1);
        catMeshes.push({object,material:object.material,mask:maskMaterials[index]});
      });
    },
    render() {
      if(!uniforms.uFrame.value)return;
      renderer.copyFramebufferToTexture(uniforms.uFrame.value);
      // Reuse the scene depth so grass, snow and the pointer occlude the mask.
      const background=scene.background;
      const cameraLayers=camera.layers.mask;
      scene.background=null;
      camera.layers.set(1);
      renderer.autoClear=false;
      renderer.clearColor();
      for(const entry of catMeshes)entry.object.material=entry.mask;
      renderer.render(scene,camera);
      for(const entry of catMeshes)entry.object.material=entry.material;
      renderer.autoClear=true;
      camera.layers.mask=cameraLayers;
      scene.background=background;
      renderer.copyFramebufferToTexture(uniforms.uCatMask.value);

      quad.material=blur;
      blur.uniforms.uSource.value=uniforms.uCatMask.value;
      blur.uniforms.uStep.value.set(1/horizontal.width,0);
      renderer.setRenderTarget(horizontal);
      renderer.render(screen,screenCamera);
      blur.uniforms.uSource.value=horizontal.texture;
      blur.uniforms.uStep.value.set(0,1/horizontal.height);
      renderer.setRenderTarget(vertical);
      renderer.render(screen,screenCamera);
      renderer.setRenderTarget(null);
      quad.material=material;
      renderer.render(screen,screenCamera);
    },
  };
}
const atmosphere=makeAtmospherePass();

function makeWindMap() {
  const size=128;
  const pixels=new Uint8Array(size*size*4);
  const wrap=(n,period)=>((n%period)+period)%period;
  function lattice(x,z,period) {
    let hash=Math.imul(wrap(x,period)+1,0x9e3779b1)^Math.imul(wrap(z,period)+1,0x85ebca6b)^SETTINGS.seed;
    hash=Math.imul(hash^(hash>>>16),0x45d9f3b);
    return ((hash^(hash>>>16))>>>0)/4294967296;
  }
  function noise(u,v,period) {
    const x=Math.floor(u*period),z=Math.floor(v*period);
    const du=u*period-x,dv=v*period-z;
    const blendX=du*du*(3-2*du),blendZ=dv*dv*(3-2*dv);
    const {lerp}=THREE.MathUtils;
    return lerp(
      lerp(lattice(x,z,period),lattice(x+1,z,period),blendX),
      lerp(lattice(x,z+1,period),lattice(x+1,z+1,period),blendX),
      blendZ,
    );
  }
  const step=1/size;
  const byte=value=>Math.round(THREE.MathUtils.clamp(value,0,1)*255);
  for(let z=0;z<size;z++)for(let x=0;x<size;x++) {
    const u=(x+.5)*step,v=(z+.5)*step;
    // Use a perpendicular gradient for smooth turns between pockets of wind.
    const curlX=noise(u,v+step,6)-noise(u,v-step,6);
    const curlZ=noise(u-step,v,6)-noise(u+step,v,6);
    const gust=.74*noise(u+.21,v-.32,7)+.26*noise(u-.37,v+.14,13);
    const i=(z*size+x)*4;
    pixels[i]=byte(.5+curlX*3.8);
    pixels[i+1]=byte(.5+curlZ*3.8);
    pixels[i+2]=byte(gust);
    pixels[i+3]=255;
  }
  const texture=new THREE.DataTexture(pixels,size,size,THREE.RGBAFormat);
  texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
  texture.minFilter=texture.magFilter=THREE.LinearFilter;
  texture.needsUpdate=true;
  return texture;
}

const uniforms = {
  uTime: { value: 0 },
  uPhase: { value: phase },
  uPixelRatio: { value: renderer.getPixelRatio() },
  uPointScale: { value: 1 },
  uNeedleDirection: { value: new THREE.Vector2(1,0) },
  uStemBend: { value: 0 },
  uCats: { value: new THREE.Vector4(.3, 2.8, -.4, 3) },
  uCatAir: { value: new THREE.Vector2() },
  uGrassHeight: { value: SETTINGS.grassHeight },
  uWindMap: { value: makeWindMap() },
  uTrampleMap: { value: trampleField.texture },
  uTrampleExtent: { value: trampleField.extent },
  uTrampleStrength: { value: 1 },
};
// A circular sector with a world-space transition on both edges.
const SEASON_BLEND_WIDTH=.72;
const SNOW_BUILD_TURNS=.23;
const SNOW_SEAM_WIDTH=.32;
const SNOW_DUST_DEPTH=.12;
const SNOW_WRAP_TURNS=.006;
const seasonGLSL = `
  const float TAU = 6.28318530718;
  vec4 seasonVector(float s) {
    return 1.0 - step(vec4(.5), abs(vec4(s) - vec4(0.,1.,2.,3.)));
  }
  float seasonCoverageAt(vec2 p, float sweep, float angle, float arc) {
    if(sweep<=.000001)return 0.;
    float offset=abs(fract(angle-.5*sweep+.5)-.5);
    float distance=(.5*sweep-offset)*arc;
    // Shrink the fringe as a season begins or completes, including at the wrap.
    float feather=min(${SEASON_BLEND_WIDTH},arc*.35*min(sweep,1.-sweep));
    if(abs(distance)>=1.55*feather)return step(0.,distance);
    float contour=.34*sin(p.x*1.5+p.y*1.9+.3)+.21*sin(p.y*4.1-p.x*2.7-1.);
    return smoothstep(-feather,feather,distance+feather*contour);
  }
  float seasonCoverage(vec2 p, float sweep) {
    return seasonCoverageAt(p,sweep,atan(p.y,p.x)/TAU,TAU*max(length(p),.96));
  }
  vec4 seasonWeights(float covered, float phase) {
    float current = mod(floor(phase), 4.0);
    return mix(seasonVector(mod(current + 3.0, 4.0)), seasonVector(current), covered);
  }
  vec4 seasons(vec2 p, float phase) {
    return seasonWeights(seasonCoverage(p,fract(phase)),phase);
  }
  float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
`;

const stemBendGLSL = `
  uniform float uStemBend;
  float stemOffset(float x) {
    float distance=clamp(x/5.65,0.,1.);
    return uStemBend*distance*distance;
  }
`;

const foxtailLightGLSL = `
  uniform vec2 uNeedleDirection;
  ${stemBendGLSL}
  float foxtailGlow(vec2 p) {
    vec2 tangent=vec2(-uNeedleDirection.y,uNeedleDirection.x);
    float along=dot(p,uNeedleDirection);
    float across=dot(p,tangent)-stemOffset(along);
    vec2 offset=vec2((along-4.87)/.86,across/.52);
    float falloff=max(0.,1.-dot(offset,offset)*.24);
    float stalk=(1.-smoothstep(.02,.32,abs(across)))
      *smoothstep(.95,1.6,along)*(1.-smoothstep(4.4,5.25,along));
    return falloff*falloff*falloff*falloff+.46*stalk;
  }
`;

// Grass and flowers sample the same drifting gusts. Individual blades retain a little tip flutter.
const windGLSL = `
  uniform float uGrassHeight;
  uniform sampler2D uWindMap;
  ${foxtailLightGLSL}
  float meadowHeight(vec2 p, vec4 season) {
    float foreground = smoothstep(1.05,2.45,p.y);
    float field = dot(season,vec4(1.12,1.40,1.30,.5));
    float tall = dot(season,vec4(1.68,1.72,1.70,.5));
    return mix(field,tall,foreground)*mix(uGrassHeight,1.,season.w);
  }
  vec3 meadowWind(vec2 p, float time) {
    vec3 local=texture2D(uWindMap,p*.098+vec2(.41,.17)-time*vec2(.058,-.026)).rgb;
    vec2 drift=(local.rg-.5)*.075;
    vec3 broad=texture2D(uWindMap,p*.052+vec2(.17,.56)-time*vec2(.038,.012)+drift).rgb;
    float gust=smoothstep(.33,.69,.65*broad.b+.35*local.b);
    vec2 direction=normalize(vec2(.94,.22)+(broad.rg-.5)*1.16+(local.rg-.5)*.68);
    return vec3(direction*(.13+.80*gust),gust);
  }
  vec3 needleWake(vec2 p, vec3 wind) {
    vec2 tangent=vec2(-uNeedleDirection.y,uNeedleDirection.x);
    float along=dot(p,uNeedleDirection);
    float behind=-dot(p,tangent);
    float lengthOfWake=.30+.33*along;
    if(along<=.96||behind<-.24||behind>lengthOfWake*1.20)return vec3(0.);
    // Existing gusts stagger the arrival and recovery across the grass.
    float lag=behind+(wind.z-.5)*.16;
    float arrival=smoothstep(-.15,.075,lag);
    float recovery=1.-smoothstep(.10,mix(.77,1.16,wind.z),lag/lengthOfWake);
    float strength=arrival*recovery*smoothstep(.96,1.75,along)*(.68+.32*wind.z);
    return vec3(tangent*2.10+wind.xy*.20,strength);
  }
  float autumnRipple(float behind, float along, float gust, float time) {
    if(along<.96||behind<0.||behind>2.85)return 0.;
    // Bend successive bands of grass behind the sweep with a broken, curved front.
    float curvedFront=behind+.12*sin(along*1.9-time*.38)+.25*(gust-.5);
    float crest=sin(curvedFront*9.4-time*1.7);
    float envelope=smoothstep(.04,.36,behind)*(1.-smoothstep(1.40,2.85,behind));
    return crest*envelope*smoothstep(.96,1.85,along)*(.65+.35*gust);
  }
`;

const trampleGLSL = `
  uniform sampler2D uTrampleMap;
  uniform float uTrampleExtent;
  uniform float uTrampleStrength;
  vec3 trampleAt(vec2 p) {
    vec3 value=texture2D(uTrampleMap,p/uTrampleExtent+.5).rgb;
    return vec3(value.r,(value.gb-vec2(128./255.))*(255./127.))*uTrampleStrength;
  }
  float snowPrintAt(vec2 p) {
    return texture2D(uTrampleMap,p/uTrampleExtent+.5).a*uTrampleStrength;
  }
`;

const catShadowGLSL = `
  uniform vec4 uCats;
  uniform vec2 uCatAir;
  float catShade(vec2 point, vec2 footprint, float falloff, float opacity) {
    float shade=1.;
    for(int i=0;i<2;i++) {
      vec2 center=i==0?uCats.xy:uCats.zw;
      float lift=uCatAir[i];
      float spread=1.+lift*1.65;
      vec2 d=(point-center-vec2(.21,-.15)*lift)*footprint;
      shade*=1.-exp(-dot(d,d)*falloff/spread)*opacity/spread;
    }
    return shade;
  }
`;

const snowAccumulationGLSL = `
  float softenSnowWrap(float cover, float phase) {
    float sweep=fract(phase);
    float winter=step(3.,phase);
    if(sweep<${SNOW_WRAP_TURNS})return mix(1.-winter,cover,smoothstep(0.,${SNOW_WRAP_TURNS},sweep));
    if(sweep>1.-${SNOW_WRAP_TURNS})return mix(cover,winter,smoothstep(1.-${SNOW_WRAP_TURNS},1.,sweep));
    return cover;
  }
  float snowMaturity(float angle, float arc, float phase) {
    // Count from the start of winter through the spring melt, across the year wrap.
    float turn=fract(angle);
    float age=(phase<1.?phase+1.:phase-3.)-turn;
    float mature=smoothstep(0.,${SNOW_BUILD_TURNS},age);
    float seam=${SNOW_SEAM_WIDTH}/arc;
    float fromSeam=min(turn,1.-turn);
    if(fromSeam<seam) {
      float otherAge=age+(turn<.5?-1.:1.);
      mature=mix(mature,smoothstep(0.,${SNOW_BUILD_TURNS},otherAge),.5*(1.-smoothstep(0.,seam,fromSeam)));
    }
    return mature;
  }
`;

const snowGLSL = `
  ${snowAccumulationGLSL}
  // Value noise with analytic slopes for the small relief in the powder.
  vec3 snowRelief(vec2 p) {
    vec2 cell=floor(p), f=fract(p);
    vec2 blend=f*f*(3.-2.*f);
    float a=hash(cell), b=hash(cell+vec2(1.,0.));
    float c=hash(cell+vec2(0.,1.)), d=hash(cell+vec2(1.,1.));
    float value=mix(mix(a,b,blend.x),mix(c,d,blend.x),blend.y);
    vec2 slope=vec2(mix(b-a,d-c,blend.y),mix(c-a,d-b,blend.x))*6.*f*(1.-f);
    return vec3(value,slope);
  }
  float snowNoise(vec2 p) { return snowRelief(p).x; }
  float snowHeight(vec2 p) {
    float radius=length(p);
    float edge=smoothstep(.99,1.18,radius)*(1.-smoothstep(5.16,5.35,radius));
    vec2 driftAxes=vec2(dot(p,vec2(.88,.48)),dot(p,vec2(-.48,.88)));
    float bank=smoothstep(.16,.86,snowNoise(driftAxes*vec2(.72,1.65)));
    float drift=.060+.076*bank+.024*snowNoise(p*4.1);
    return -.012+edge*drift;
  }
`;

function makeSky() {
  const sky = document.createElement('canvas');
  sky.width = 2048; sky.height = 1152;
  const c = sky.getContext('2d');
  c.fillStyle = '#040709'; c.fillRect(0, 0, sky.width, sky.height);
  const vignette = c.createRadialGradient(1000, 430, 50, 1000, 430, 1300);
  vignette.addColorStop(0, '#0a1015'); vignette.addColorStop(.7, '#05090c'); vignette.addColorStop(1, '#020405');
  c.fillStyle = vignette; c.fillRect(0, 0, 2048, 1152);
  c.save(); c.translate(1024, 300); c.rotate(-.25); c.scale(1, .32);
  for (let i = 0; i < 230; i++) {
    const x = between(-1450, 1450), y = between(-220, 220), r = between(70, 260);
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${between(66, 91)|0},${between(78, 100)|0},${between(104, 134)|0},${between(.012, .047)})`);
    g.addColorStop(1, 'rgba(40,55,80,0)');
    c.fillStyle = g; c.fillRect(x-r, y-r, r*2, r*2);
  }
  c.restore();
  for (let i = 0; i < 5200; i++) {
    const x = random() * 2048;
    const y = i < 2200 ? 300 - (x - 1024) * .25 + between(-150, 150) * random() : random() * 1152;
    const size = random() < .025 ? between(1.1, 1.9) : between(.25, .9);
    const brightness = between(.08, .48) * (size > 1 ? .8 : .6);
    c.fillStyle = `rgba(199,210,221,${brightness})`;
    c.beginPath(); c.arc(x, y, size, 0, TAU); c.fill();
    if (size > 1.5) {
      const glowRadius = size * 6.5;
      const g = c.createRadialGradient(x, y, 0, x, y, glowRadius);
      g.addColorStop(0, 'rgba(185,208,236,.19)'); g.addColorStop(1, 'rgba(185,208,236,0)');
      c.fillStyle = g; c.fillRect(x-glowRadius, y-glowRadius, glowRadius*2, glowRadius*2);
    }
  }
  const texture = new THREE.CanvasTexture(sky);
  texture.colorSpace = THREE.SRGBColorSpace;
  scene.background = texture;
}

function makeDisc() {
  const edgeMaterial = new THREE.MeshStandardMaterial({ color: '#080c0b', roughness: .55, metalness: .32 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(SETTINGS.radius, SETTINGS.radius + .025, .23, 192), edgeMaterial);
  base.position.y = -.14;
  scene.add(base);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(SETTINGS.radius - .035, 192), new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `varying vec2 vPosition; void main() { vec4 w = modelMatrix * vec4(position,1.); vPosition=w.xz; gl_Position=projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `
      uniform float uPhase; varying vec2 vPosition;
      ${seasonGLSL}
      ${foxtailLightGLSL}
      void main() {
        vec4 s = seasons(vPosition,uPhase);
        float r = length(vPosition);
        vec3 color = mat4x3(vec3(.086,.14,.043),vec3(.068,.129,.028),vec3(.274,.186,.072),vec3(.22,.21,.17)) * s;
        float grooves = .74 + .26 * smoothstep(-.8,.8,sin(r*173.));
        color *= mix(.85,grooves,s.w) * (.78 + .22*hash(floor(vPosition*165.)));
        color += vec3(.22,.114,.025)*foxtailGlow(vPosition);
        gl_FragColor = vec4(color,1.);
      }`,
  }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -.018; scene.add(ground);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(SETTINGS.radius - .01, .018, 6, 192), new THREE.MeshStandardMaterial({ color: '#293026', metalness: .65, roughness: .55 }));
  rim.rotation.x = Math.PI / 2; rim.position.y = -.025; scene.add(rim);
  const ticks = new THREE.InstancedMesh(new THREE.BoxGeometry(.031, .008, .095), new THREE.MeshStandardMaterial({ color: '#767967', roughness: .7 }), 100);
  const object = new THREE.Object3D();
  for (let i = 0; i < 100; i++) {
    const a = i / 100 * TAU;
    object.position.set(Math.cos(a) * (SETTINGS.radius - .04), -.009, Math.sin(a) * (SETTINGS.radius - .04));
    object.rotation.y = Math.PI / 2 - a;
    object.scale.setScalar(i % 5 === 0 ? 1 : .65); object.updateMatrix(); ticks.setMatrixAt(i, object.matrix);
  }
  scene.add(ticks);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(SETTINGS.hubRadius, SETTINGS.hubRadius + .025, .13, 128), new THREE.MeshStandardMaterial({ color: '#050706', roughness: .48, metalness: .4 }));
  hub.position.y = .064; scene.add(hub);
  for (const [radius, thickness, color] of [[.959,.016,'#8e8864'],[.65,.009,'#454d3a'],[.28,.005,'#202b22']]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, thickness, 7, 128), new THREE.MeshStandardMaterial({ color, metalness: .6, roughness: .47 }));
    ring.rotation.x = Math.PI / 2; ring.position.y = .133; scene.add(ring);
  }
  const spindle = new THREE.Mesh(new THREE.SphereGeometry(.037, 12, 8), new THREE.MeshStandardMaterial({ color: '#4c503c', metalness: .8, roughness: .4 }));
  spindle.position.y = .147; scene.add(spindle);
}

function makeSnowCover() {
  const positions=[],indices=[];
  const radial=48,angular=192;
  for(let row=0;row<=radial;row++) {
    const radius=1.003+(5.355-1.003)*row/radial;
    for(let col=0;col<=angular;col++) {
      const a=col/angular*TAU;
      positions.push(Math.cos(a)*radius,0,Math.sin(a)*radius);
      if(row<radial&&col<angular) {
        const i=row*(angular+1)+col;
        indices.push(i,i+angular+1,i+1,i+1,i+angular+1,i+angular+2);
      }
    }
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setIndex(indices);
  const material=new THREE.ShaderMaterial({
    uniforms, side:THREE.DoubleSide, alphaToCoverage:true,
    vertexShader:`
      uniform float uPhase;
      varying vec3 vWorld; varying vec3 vNormal; varying float vMaturity;
      ${seasonGLSL}
      ${snowGLSL}
      ${trampleGLSL}
      void main() {
        vec2 p=position.xz;
        float angle=atan(p.y,p.x)/TAU;
        float arc=TAU*max(length(p),.96);
        float cover=softenSnowWrap(seasonWeights(seasonCoverageAt(p,fract(uPhase),angle,arc),uPhase).w,uPhase);
        vMaturity=snowMaturity(angle,arc,uPhase);
        float thickness=smoothstep(.02,.98,cover)*mix(${SNOW_DUST_DEPTH},1.,vMaturity);
        float surface=mix(-.018,snowHeight(p),thickness)-.034*snowPrintAt(p)*thickness;
        vec3 world=vec3(p.x,surface,p.y);
        float dx=(snowHeight(p+vec2(.035,0.))-snowHeight(p-vec2(.035,0.)))/.07;
        float dz=(snowHeight(p+vec2(0.,.035))-snowHeight(p-vec2(0.,.035)))/.07;
        vNormal=normalize(vec3(-dx*thickness,1.,-dz*thickness)); vWorld=world;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(world,1.);
      }`,
    fragmentShader:`
      uniform float uPhase;
      varying vec3 vWorld; varying vec3 vNormal; varying float vMaturity;
      ${seasonGLSL}
      ${snowGLSL}
      ${catShadowGLSL}
      ${trampleGLSL}
      ${foxtailLightGLSL}
      void main() {
        vec2 p=vWorld.xz;
        float pixelSpan=max(length(dFdx(p)),length(dFdy(p)));
        // Re-evaluate the angular edge per pixel; interpolating the mask across
        // the ring would leave visible triangles along the seasonal boundary.
        float cover=softenSnowWrap(seasons(p,uPhase).w,uPhase);
        if(cover<.11)discard;
        // Small deposits coalesce in place before they become a continuous blanket.
        float packed=cover*mix(.30,1.,vMaturity*vMaturity);
        float opacity=1.;
        if(packed<.92) {
          float snowThreshold=.13+.58*snowNoise(p*3.8)+.16*hash(floor(p*56.));
          opacity=smoothstep(snowThreshold-.045,snowThreshold+.050,packed);
          if(opacity<.015)discard;
        }
        float printStrength=mix(.35,1.,vMaturity);
        float print=snowPrintAt(p)*printStrength;
        vec2 stepSize=vec2(.033,0.);
        float printDx=snowPrintAt(p+stepSize)-snowPrintAt(p-stepSize);
        float printDz=snowPrintAt(p+stepSize.yx)-snowPrintAt(p-stepSize.yx);
        float detail=1.-smoothstep(.030,.080,pixelSpan);
        vec3 grain=snowRelief(p*13.);
        vec3 normal=normalize(vNormal+vec3(printDx,0.,printDz)*(.68*printStrength)
          -vec3(grain.y,0.,grain.z)*mix(.035,.080,vMaturity)*detail);
        float light=clamp(dot(normal,normalize(vec3(-.61,.71,.45))),0.,1.);
        float bank=snowNoise(p*1.45);
        float softLight=clamp(.13+.91*light+.10*(bank-.5),0.,1.);
        vec3 color=mix(vec3(.58,.70,.82),vec3(.96,.982,.99),softLight);
        color*=.97+.11*(bank-.5)+.027*(grain.x-.5)*detail;
        color*=mix(vec3(1.),vec3(.58,.68,.76),smoothstep(.04,.85,print));
        float fleck=hash(floor(p*64.));
        color+=detail*vec3(.87,.95,1.)*smoothstep(.991,1.,fleck)*.038;
        float radius=length(vWorld.xz);
        color*=.87+.13*smoothstep(1.0,1.3,radius);
        color*=catShade(vWorld.xz,vec2(.9,1.5),9.,.20);
        color*=mix(.90,1.,smoothstep(.18,.80,cover));
        color*=mix(.91,1.,vMaturity);
        color+=vec3(.077,.038,.008)*foxtailGlow(p);
        gl_FragColor=vec4(color,opacity);
      }`,
  });
  const blanket=new THREE.Mesh(geometry,material);
  blanket.frustumCulled=false;
  // Write snow depth before drawing the grass that can be buried beneath it.
  blanket.renderOrder=-1;
  scene.add(blanket);
  return blanket;
}

function groundPosition() {
  const angle = random() * TAU;
  const r = Math.sqrt(between((SETTINGS.hubRadius + .045) ** 2, (SETTINGS.radius - .07) ** 2));
  return [Math.cos(angle) * r, Math.sin(angle) * r];
}

function makeBladeGeometry(profile,roots,traits) {
  const geometry = new THREE.InstancedBufferGeometry();
  const vertices = [], indices = [];
  const segments=profile.length;
  for (let j = 0; j < segments; j++) {
    const [t,width]=profile[j];
    const halfWidth=width*.5;
    vertices.push(-halfWidth,t,0,halfWidth,t,0);
    const k = j * 2; indices.push(k,k+1,k+2);
    if(j<segments-1)indices.push(k+1,k+3,k+2);
  }
  vertices.push(0,1,0);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  const count=roots.length/4;
  const order=new Uint32Array(count);
  for(let i=0;i<count;i++) {
    // The camera faces the disc from positive Z. Sort into narrow depth bands once.
    const band=Math.floor((SETTINGS.radius-roots[i*4+1])*8);
    order[i]=band*count+i;
  }
  order.sort();
  const sortedRoots=new Float32Array(roots.length), sortedTraits=new Float32Array(traits.length);
  for(let i=0;i<count;i++) {
    const source=(order[i]%count)*4;
    for(let c=0;c<4;c++) {
      sortedRoots[i*4+c]=roots[source+c];
      sortedTraits[i*4+c]=traits[source+c];
    }
  }
  geometry.setAttribute('aRoot', new THREE.InstancedBufferAttribute(sortedRoots,4));
  geometry.setAttribute('aTraits', new THREE.InstancedBufferAttribute(sortedTraits,4));
  geometry.instanceCount = count;
  return geometry;
}

function makeGrass() {
  const roots = new Float32Array(SETTINGS.blades * 4), traits = new Float32Array(SETTINGS.blades * 4);
  const tuftSize=7;
  const innerRadius=SETTINGS.hubRadius+.045,outerRadius=SETTINGS.radius-.07;
  let detailedCount=0, simpleStart=SETTINGS.blades;
  let tuft,tuftHeight;
  for (let i = 0; i < SETTINGS.blades; i++) {
    const member=i%tuftSize;
    if(member===0) {
      tuft=groundPosition();
      tuftHeight=between(.93,1.12);
    }
    const angle=random()*TAU,spread=.073*Math.sqrt(random());
    const x=tuft[0]+Math.cos(angle)*spread,z=tuft[1]+Math.sin(angle)*spread;
    const radius=Math.hypot(x,z);
    const fittedRadius=THREE.MathUtils.clamp(radius,innerRadius,outerRadius);
    const fit=fittedRadius/radius;
    const undergrowth=member<2;
    const height=tuftHeight*(undergrowth?between(.086,.155):between(.148,.244));
    const width=undergrowth?between(.010,.016):between(.0048,.0095);
    const yaw=random()*TAU;
    // Keep the full blade profile near the cats and the foreground silhouette.
    const index=!undergrowth&&z*fit>1.05?detailedCount++:--simpleStart;
    roots.set([x*fit,z*fit,Math.atan2(z,x)/TAU,TAU*fittedRadius],index*4);
    traits.set([height,width*Math.cos(yaw),width*Math.sin(yaw),random()],index*4);
  }
  const material = new THREE.ShaderMaterial({
    uniforms, side: THREE.DoubleSide, alphaToCoverage:true,
    vertexShader: `
      uniform float uTime; uniform float uPhase;
      attribute vec4 aRoot; attribute vec4 aTraits;
      varying float vHeight; varying vec4 vShade; varying float vNoise; varying float vPressure; varying vec4 vSeason;
      varying float vAcross;
      ${seasonGLSL}
      ${snowAccumulationGLSL}
      ${windGLSL}
      ${trampleGLSL}
      ${catShadowGLSL}
      void main() {
        vec2 root=aRoot.xy;
        float coverage=seasonCoverageAt(root,fract(uPhase),aRoot.z,aRoot.w);
        vec4 s=seasonWeights(coverage,uPhase);
        float exposed=s.w>0.?.56*(1.-snowMaturity(aRoot.z,aRoot.w,uPhase)):0.;
        s.z+=s.w*exposed;
        s.w*=1.-exposed;
        float t = position.y;
        float h = aTraits.x * meadowHeight(root,s);
        h *= 1. - s.w * (1.-(.43+.57*pow(aTraits.w,14.)));
        vec2 sideways = normalize(aTraits.yz);
        vec3 wind=meadowWind(root,uTime);
        vec3 wake=needleWake(root,wind);
        float along=dot(root,uNeedleDirection);
        float crossDistance=root.x*uNeedleDirection.y-root.y*uNeedleDirection.x;
        float ripple=0.;
        if(uPhase>=2.&&uPhase<3.&&s.z>0.) {
          ripple=s.z*autumnRipple(crossDistance,along,wind.z,uTime);
        }
        vec2 flow=mix(wind.xy,wake.xy,wake.z)+vec2(-root.y,root.x)*.018*s.z;
        flow+=vec2(-uNeedleDirection.y,uNeedleDirection.x)*(.72*ripple);
        float flowLength=length(flow);
        vec2 direction=flow/max(flowLength,.001);
        float bendAngle=clamp((.14+flowLength*1.24)*(.83+aTraits.w*.33),.08,1.45+.72*wake.z+.48*abs(ripple));
        bendAngle*=1.-s.w*mix(.83,.50,wake.z);
        float theta=bendAngle*t;
        vec2 curl=vec2(-sideways.y,sideways.x)*(.13+.20*aTraits.w);
        curl+=sideways*(fract(aTraits.w*8.13)-.5)*.16;
        curl*=h*(1.-s.w*.82);
        vec2 bend=direction*h*(1.-cos(theta))/bendAngle+curl*t*t*t;
        bend+=sideways*sin(uTime*3.8+aTraits.w*27.)*.009*t*t*t*(1.-s.w);
        vec3 trample=trampleAt(root);
        float pressure=clamp(trample.x*1.12,0.,.96);
        vec2 laid=trample.yz*.60+direction*h*.16*pressure;
        bend=mix(bend,laid*t*t,pressure);
        vec2 tangentXZ=direction*h*sin(theta)+3.*curl*t*t;
        vec3 tangent=normalize(vec3(tangentXZ.x,h*cos(theta),tangentXZ.y));
        vec3 pressedTangent=normalize(vec3(laid.x,.055,laid.y));
        tangent=normalize(mix(tangent,pressedTangent,pressure));
        vec3 bladeNormal=normalize(cross(vec3(sideways.x,0.,sideways.y),tangent));
        float shadow=catShade(root,vec2(.9,1.6),7.,.40);
        vec3 world = vec3(root.x,0.,root.y);
        world.xz += aTraits.yz*position.x + bend;
        world.y = h*sin(theta)/bendAngle*(1.-pressure*.87);
        // Individual blades mature at slightly different points inside the fringe.
        float changeAt=.13+.74*fract(aTraits.w*11.57);
        float mature=smoothstep(changeAt-.12,changeAt+.12,coverage);
        vSeason=seasonWeights(mix(coverage,mature,.65),uPhase);
        vSeason.z+=vSeason.w*exposed;
        vSeason.w*=1.-exposed;
        vHeight=t; vNoise=aTraits.w; vPressure=pressure; vAcross=sign(position.x);
        vShade.x=(.82+.14*abs(dot(bladeNormal,normalize(vec3(-.5,.85,.4)))))*(.92+.13*wind.z)*shadow*(1.-pressure*.16);
        vShade.y=1.-.15*exp(-crossDistance*crossDistance*100.)*step(.9,along)*step(along,5.);
        // Bent tips catch a little warm light in the wake, varying with their angle and the gusts.
        vec3 sweepLight=vec3(-.91*uNeedleDirection.y,.414,.91*uNeedleDirection.x);
        float sheen=.49+.51*abs(dot(bladeNormal,sweepLight));
        vShade.z=smoothstep(.14,.81,wake.z)*smoothstep(-.025,.18,crossDistance)
          *sheen*(.75+.25*wind.z)*(.67+.33*aTraits.w)*(1.-s.w);
        vShade.z+=.38*ripple*(1.-pressure);
        vShade.w=foxtailGlow(world.xz);
        gl_Position = projectionMatrix*modelViewMatrix*vec4(world,1.);
      }`,
    fragmentShader: `
      varying float vHeight; varying vec4 vShade; varying float vNoise; varying float vPressure; varying vec4 vSeason;
      varying float vAcross;
      void main() {
        vec3 root = mat4x3(vec3(.075,.148,.049),vec3(.077,.151,.058),vec3(.40,.274,.117),vec3(.55,.63,.66))*vSeason;
        vec3 tip = mat4x3(vec3(.44,.60,.305),vec3(.425,.59,.232),vec3(1.,.785,.452),vec3(.88,.93,.94))*vSeason;
        vec3 color = mix(root,tip,.16+.79*pow(vHeight,.62));
        color *= (.93+vNoise*.12) * vShade.x * .80;
        color += tip*.045*smoothstep(.52,.99,vHeight)*(1.-vPressure*.60);
        color += vec3(.23,.122,.024)*vShade.z*smoothstep(.25,.94,vHeight);
        color*=vShade.y;
        color*=1.-vPressure*.30*(1.-vHeight*.25);
        color+=vec3(.34,.19,.046)*vShade.w*(.36+.64*vHeight);
        float coverage=1.-.32*smoothstep(.58,1.,abs(vAcross));
        gl_FragColor=vec4(color,coverage);
      }`,
  });
  const split=detailedCount*4;
  const detailed=makeBladeGeometry([[0,.76],[.25,1],[.50,.85],[.75,.48]],roots.subarray(0,split),traits.subarray(0,split));
  const simple=makeBladeGeometry([[0,.76],[.45,1]],roots.subarray(split),traits.subarray(split));
  for(const geometry of [detailed,simple]) {
    const grass = new THREE.Mesh(geometry, material);
    grass.frustumCulled = false; scene.add(grass);
  }
}

function makeFlowers() {
  const points = new Float32Array(SETTINGS.flowers * 3), traits = new Float32Array(SETTINGS.flowers * 2);
  for (let i = 0; i < SETTINGS.flowers; i++) {
    const [x,z] = groundPosition(); points.set([x,between(.15,.30),z], i*3); traits.set([random(),random()],i*2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(points,3));
  geometry.setAttribute('aTraits',new THREE.BufferAttribute(traits,2));
  const material = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false,
    vertexShader: `
      uniform float uTime; uniform float uPhase; uniform float uPointScale;
      attribute vec2 aTraits; varying float vAlpha; varying vec3 vColor;
      ${seasonGLSL}
      ${windGLSL}
      ${trampleGLSL}
      void main() {
        vec4 s=seasons(position.xz,uPhase);
        vec3 p=position;
        vec3 wind=meadowWind(position.xz,uTime);
        vec3 wake=needleWake(position.xz,wind);
        vec2 flow=mix(wind.xy,wake.xy,wake.z);
        float flowLength=length(flow);
        float bendAngle=clamp(.14+flowLength*1.24,.08,1.45+.72*wake.z);
        float h=p.y*meadowHeight(position.xz,s);
        vec3 trample=trampleAt(position.xz);
        float pressure=clamp(trample.x*1.12,0.,.96);
        vec2 direction=flow/max(flowLength,.001);
        vec2 bend=direction*h*(1.-cos(bendAngle))/bendAngle;
        vec2 laid=trample.yz*.60+direction*h*.16*pressure;
        p.xz+=mix(bend,laid,pressure);
        p.y=h*sin(bendAngle)/bendAngle*(1.-pressure*.87)+.008;
        vec4 view=modelViewMatrix*vec4(p,1.);
        float summerBloom=step(.74,aTraits.x);
        vAlpha=(s.x*.84+s.y*.62*summerBloom)*(.4+.6*aTraits.x);
        vColor=mix(vec3(.86,.89,.78),vec3(.82,.89,.9),s.w);
        vColor=mix(vColor,vec3(.94,.95,.92),s.y);
        gl_PointSize=(.75+aTraits.y*1.2)*uPointScale*17./-view.z;
        gl_Position=projectionMatrix*view;
      }`,
    fragmentShader: `
      varying float vAlpha; varying vec3 vColor;
      void main() {
        vec2 p=gl_PointCoord-.5;
        float alpha=1.-smoothstep(.2,.5,length(p));
        if(alpha*vAlpha<.035)discard;
        gl_FragColor=vec4(vColor,alpha*vAlpha);
      }`,
  });
  const flowers = new THREE.Points(geometry, material);
  flowers.frustumCulled=false; scene.add(flowers);
  return flowers;
}

function makeFoxtail() {
  const pivot = new THREE.Group();
  pivot.position.y = .16; scene.add(pivot);
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(.15,.008,0),new THREE.Vector3(1.6,.055,.015),
    new THREE.Vector3(3.3,.11,.025),new THREE.Vector3(4.85,.26,.012),new THREE.Vector3(5.65,.37,0),
  ]);
  const stemMaterial=new THREE.MeshStandardMaterial({
    color:'#dfca88',roughness:.6,metalness:.2,emissive:'#dfb55a',emissiveIntensity:.72,
  });
  stemMaterial.onBeforeCompile=shader=>{
    shader.uniforms.uStemBend=uniforms.uStemBend;
    shader.vertexShader=stemBendGLSL+shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\ntransformed.z+=stemOffset(position.x);');
  };
  const stem = new THREE.Mesh(new THREE.TubeGeometry(curve,64,.015,5,false),stemMaterial);
  stem.frustumCulled=false;
  pivot.add(stem);
  const head = new THREE.Group(); head.position.set(4.62,.224,.017); head.rotation.z=.135;
  pivot.add(head);
  const profile=[];
  for(let i=0;i<=24;i++) {
    const t=i/24;
    profile.push(new THREE.Vector2(.093*Math.pow(Math.sin(Math.PI*t),.6)*(1.-t*.25)+.003,t*1.06));
  }
  const core=new THREE.Mesh(new THREE.LatheGeometry(profile,16),new THREE.MeshBasicMaterial({color:'#ccb361',toneMapped:false}));
  core.rotation.z=-Math.PI/2; head.add(core);
  const bristles=[],colors=[];
  for(let i=0;i<1900;i++) {
    const t=random(), a=random()*TAU;
    const r=.093*Math.pow(Math.sin(Math.PI*t),.6)*(1.-t*.25);
    const length=between(.035,.10)*Math.pow(Math.sin(t*Math.PI),.35);
    const x=t*1.06,y=Math.cos(a)*r,z=Math.sin(a)*r;
    bristles.push(x,y,z,x+length*.68,y+Math.cos(a)*length,z+Math.sin(a)*length);
    const brightness=between(.38,.72);
    colors.push(brightness,brightness*.68,brightness*.20,brightness,brightness*.77,brightness*.32);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(bristles,3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  head.add(new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.7})));
  return {pivot,head};
}

const sphereGeometry = new THREE.SphereGeometry(1,20,14);
const catNoseOutline=new THREE.Shape();
catNoseOutline.moveTo(-.018,.006);
catNoseOutline.quadraticCurveTo(-.018,.011,0,.009);
catNoseOutline.quadraticCurveTo(.018,.011,.018,.006);
catNoseOutline.quadraticCurveTo(.016,0,.005,-.007);
catNoseOutline.quadraticCurveTo(0,-.014,-.005,-.007);
catNoseOutline.quadraticCurveTo(-.016,0,-.018,.006);
const catNoseGeometry=new THREE.ExtrudeGeometry(catNoseOutline,{
  depth:.005,bevelSize:.002,bevelThickness:.002,bevelSegments:2,curveSegments:6,
});
catNoseGeometry.rotateY(Math.PI/2);
let catSkinGeometry;

function ellipsoid(parent, material, position, scale) {
  const mesh=new THREE.Mesh(sphereGeometry,material);
  mesh.position.set(...position); mesh.scale.set(...scale); parent.add(mesh); return mesh;
}

function makeCatTail(parent,fur) {
  const curve=new THREE.CatmullRomCurve3([
    new THREE.Vector3(0,0,0),new THREE.Vector3(-.14,.025,0),
    new THREE.Vector3(-.29,.067,.009),new THREE.Vector3(-.405,.119,.018),
    new THREE.Vector3(-.45,.158,.024),
  ]);
  const rings=20,sides=8,spacing=.15;
  const geometry=new THREE.TubeGeometry(curve,rings,1,sides,false);
  const positions=geometry.getAttribute('position');
  const skinIndex=[],skinWeight=[];
  for(let ring=0;ring<=rings;ring++) {
    const t=ring/rings;
    const center=curve.getPointAt(t);
    const radius=.034*(1-.66*t)*(1-.90*THREE.MathUtils.smoothstep(t,.93,1));
    const segment=Math.min(3,-center.x/spacing);
    const bone=Math.min(2,Math.floor(segment));
    const blend=segment-bone;
    for(let side=0;side<=sides;side++) {
      const vertex=ring*(sides+1)+side;
      positions.setXYZ(vertex,
        center.x+(positions.getX(vertex)-center.x)*radius,
        center.y+(positions.getY(vertex)-center.y)*radius,
        center.z+(positions.getZ(vertex)-center.z)*radius);
      skinIndex.push(bone,bone+1,0,0);
      skinWeight.push(1-blend,blend,0,0);
    }
  }
  geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(skinIndex,4));
  geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(skinWeight,4));
  const tail=new THREE.SkinnedMesh(geometry,fur);
  tail.position.set(-.294,.347,0);
  tail.frustumCulled=false;
  parent.add(tail);
  const bones=Array.from({length:4},()=>new THREE.Bone());
  tail.add(bones[0]);
  for(let i=1;i<bones.length;i++) {
    bones[i].position.x=-spacing;
    bones[i-1].add(bones[i]);
  }
  tail.updateWorldMatrix(true,true);
  tail.bind(new THREE.Skeleton(bones));
  return bones;
}

const catLegY=.34;
const foreleg={shoulderX:.18,upper:.128,forearm:.138,toeX:.012,toeY:-.040};
const rearleg={upper:.19,pawX:.049,pawY:-.102,padHeight:.026};

function makeCat(white) {
  const root=new THREE.Group(); root.scale.setScalar(.72); scene.add(root);
  const bodyPivot=new THREE.Group(); bodyPivot.position.y=.334; root.add(bodyPivot);
  const bodyGroup=new THREE.Group(); bodyGroup.position.y=-bodyPivot.position.y; bodyPivot.add(bodyGroup);
  const fur=new THREE.MeshStandardMaterial({
    color:white?'#e4e2cb':'#0c1119',roughness:.95,metalness:0,
    emissive:white?'#9a907c':'#171d27',emissiveIntensity:white?.09:.12,
  });
  const rimGlow=white?new THREE.Color('#ffe0a6').multiplyScalar(.10)
    :new THREE.Color('#80baff').multiplyScalar(.25);
  fur.onBeforeCompile=shader=>{
    shader.uniforms.uFurGlow={value:rimGlow};
    shader.fragmentShader='uniform vec3 uFurGlow;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <emissivemap_fragment>',`
      #include <emissivemap_fragment>
      vec3 rimDirection=normalize((viewMatrix*vec4(.40,.67,-.63,0.)).xyz);
      float edge=1.-clamp(dot(normal,normalize(vViewPosition)),0.,1.);
      float rim=smoothstep(.25,.95,edge)*smoothstep(.10,.75,dot(normal,rimDirection));
      totalEmissiveRadiance+=uFurGlow*rim;
    `);
  };
  const inner=new THREE.MeshStandardMaterial({color:white?'#bd9e94':'#46404b',roughness:1});
  const eyeMat=new THREE.MeshStandardMaterial({color:white?'#989954':'#b6bd81',emissive:'#5d6345',emissiveIntensity:.16,roughness:.45});
  const pupilMat=new THREE.MeshStandardMaterial({color:'#090c10',roughness:.55});
  const volumes=[];
  const volume=(bone,center,radii,tilt)=>volumes.push({bone,center,radii,tilt});
  const body=new THREE.Bone(); body.position.y=.334; bodyGroup.add(body);
  volume(body,[-.221,.004,0],[.156,.140,.122]);
  volume(body,[-.027,.013,0],[.247,.121,.112]);
  volume(body,[.159,.036,0],[.168,.134,.116]);
  volume(body,[.223,.071,0],[.127,.096,.097],.59);
  const head=new THREE.Bone(); head.position.set(.295,.48,0); bodyGroup.add(head);
  volume(head,[-.012,.012,0],[.115,.117,.124]);
  volume(head,[-.070,-.052,0],[.101,.087,.091],.54);
  volume(head,[.034,-.039,0],[.078,.068,.115]);
  for(const side of [-1,1])volume(head,[.084,-.044,side*.036],[.040,.036,.049]);
  volume(head,[.058,-.086,0],[.048,.030,.063]);
  const noseMaterial=new THREE.MeshStandardMaterial({color:white?'#9f7c74':'#202431',roughness:.8});
  const nose=new THREE.Mesh(catNoseGeometry,noseMaterial);
  nose.position.set(.130,-.031,0); head.add(nose);
  const mouthGeometry=new THREE.BufferGeometry();
  mouthGeometry.setAttribute('position',new THREE.Float32BufferAttribute([
    .135,-.042,0,.134,-.060,0,
    .134,-.060,0,.131,-.066,-.019,.131,-.066,-.019,.128,-.063,-.042,
    .134,-.060,0,.131,-.066,.019,.131,-.066,.019,.128,-.063,.042,
  ],3));
  head.add(new THREE.LineSegments(mouthGeometry,new THREE.LineBasicMaterial({
    color:white?'#61574e':'#090b10',transparent:true,opacity:.60,depthWrite:false,
  })));
  const ears=[];
  for(const side of [-1,1]) {
    const ear=new THREE.Group();
    ear.position.set(-.026,.075,side*.073); head.add(ear);
    const shell=new THREE.Mesh(new THREE.ConeGeometry(.065,.152,3),fur);
    shell.position.y=.056; shell.rotation.z=.12; ear.add(shell);
    const inset=new THREE.Mesh(new THREE.ConeGeometry(.037,.100,3),inner);
    inset.position.set(.023,.054,0); inset.rotation.z=-.13; ear.add(inset);
    ears.push({joint:ear,side});
    const eye=new THREE.Group();
    eye.position.set(.082,.031,side*.073); eye.rotation.y=-side*.49; head.add(eye);
    ellipsoid(eye,pupilMat,[0,0,0],[.008,.021,.023]);
    ellipsoid(eye,eyeMat,[.005,0,0],[.006,.017,.020]);
    ellipsoid(eye,pupilMat,[.011,0,0],[.0028,.013,.0045]);
  }
  const legs=[];
  for(const x of [-.205,foreleg.shoulderX])for(const side of [-1,1]) {
    const pivot=new THREE.Bone(); pivot.position.set(x,catLegY,side*.084); bodyGroup.add(pivot);
    const front=x>0;
    const lower=new THREE.Bone(); lower.position.y=-(front?foreleg.upper:rearleg.upper); pivot.add(lower);
    let wrist,paw;
    if(front) {
      volume(pivot,[.003,-.053,0],[.049,.092,.042]);
      volume(lower,[0,-.061,0],[.034,.095,.031]);
      wrist=new THREE.Bone(); wrist.position.y=-foreleg.forearm; lower.add(wrist);
      volume(wrist,[.006,-.012,0],[.026,.038,.027]);
      paw=ellipsoid(wrist,fur,[foreleg.toeX,foreleg.toeY,0],[.037,.022,.031]);
    } else {
      volume(pivot,[-.004,-.063,0],[.073,.141,.057]);
      volume(lower,[.019,-.052,0],[.034,.078,.031],.33);
      paw=ellipsoid(lower,fur,[rearleg.pawX,rearleg.pawY,0],[.050,rearleg.padHeight,.037]);
    }
    paw.visible=false;
    volume(paw,[0,0,0],[1,1,1]);
    legs.push({pivot,lower,wrist,paw,front,side,sole:new THREE.Vector3(),snowContact:false});
  }
  const neutral=catHopSpline.evaluate(0);
  for(const leg of legs)poseHopLeg(leg,neutral,0,false);
  const skin=makeCatSkin(bodyGroup,volumes,fur,catSkinGeometry);
  catSkinGeometry=skin.geometry;
  const tailBones=makeCatTail(bodyGroup,fur);
  const whiskers=[];
  for(const side of [-1,1])for(let k=0;k<3;k++) {
    whiskers.push(.113,-.045-k*.006,side*(.060+k*.004),.147-k*.027,-.029-k*.027,side*(.154+k*.012));
  }
  const whiskerGeometry=new THREE.BufferGeometry();
  whiskerGeometry.setAttribute('position',new THREE.Float32BufferAttribute(whiskers,3));
  head.add(new THREE.LineSegments(whiskerGeometry,new THREE.LineBasicMaterial({color:white?'#c9c8b6':'#71808d',transparent:true,opacity:.45})));
  const cat={root,bodyPivot,body,head,ears,tailBones,legs,skin};
  cat.takeoffSupport=hopSupportAt(cat,CAT_HOP.launch);
  cat.landingSupport=hopSupportAt(cat,CAT_HOP.land);
  return cat;
}

const CAT_HOP = {
  crouch:.105, launch:.24, climbEnd:.325,
  levelStart:.45, levelEnd:.52,
  land:.685, absorb:.77, hindDown:.875,
};
const CAT_CYCLE_SECONDS=14;
const CAT_REST={prepare:.85,lower:.88,rise:.91,pitch:.74,floor:.082};
const catLandings = Array.from({length:8},(_,i)=>{
  const angle=i*TAU/8-Math.PI*.75;
  return {x:Math.cos(angle)*1.72,z:2.99+Math.sin(angle)*.70};
});

// A beat either holds its position or travels to a fraction of the next waypoint.
const catRoutines=[
  [
    {kind:'peek',seconds:.72},
    {kind:'jump',seconds:1.80,to:1},
    {kind:'scan',seconds:.78},
  ],
  [
    {kind:'walk',seconds:.91,to:.43},
    {kind:'sniff',seconds:.93},
    {kind:'walk',seconds:1.10,to:1},
    {kind:'peek',seconds:.72},
  ],
  [
    {kind:'stalk',seconds:1.02,to:.32},
    {kind:'pounce',seconds:1.54,to:1},
    {kind:'sniff',seconds:.89},
  ],
  [
    {kind:'scan',seconds:.78},
    {kind:'pounce',seconds:1.50,to:.59},
    {kind:'peek',seconds:.68},
    {kind:'walk',seconds:1.00,to:1},
  ],
].map(beats=>{
  let seconds=0,position=0,moveEnd=0;
  const segments=beats.map(({kind,seconds:duration,to=position},index)=>{
    const beat={kind,start:seconds,end:seconds+duration,from:position,to};
    seconds=beat.end+(index<beats.length-1?.42:0);
    if(to>position)moveEnd=beat.end;
    position=to;
    return beat;
  });
  return {segments,seconds,moveEnd};
});
const catRoutineSeed=Math.floor(Math.random()*4294967296);
const catRoutineOrders=[null,null];
const catIdlePose = {front:[.06,-.08], hind:[-.24,.12], stretch:1, tail:.02};
const catHopPoses = [
  {at:0,...catIdlePose},
  {at:CAT_HOP.crouch,front:[1.04,-1.91],hind:[-.85,1.13],stretch:.91,tail:.15},
  {at:CAT_HOP.launch,front:[.74,-1.42],hind:[-1.19,.19],stretch:1.10,tail:-.14},
  {at:CAT_HOP.climbEnd,front:[.90,-1.39],hind:[-1.04,.46],stretch:1.13,tail:-.20},
  {at:CAT_HOP.levelStart,front:[1.32,-.36],hind:[-1.03,.25],stretch:1.16,tail:-.12},
  {at:CAT_HOP.levelEnd,front:[1.36,-.40],hind:[-1.05,.27],stretch:1.17,tail:-.13},
  {at:.60,front:[1.27,-.42],hind:[-.82,.69],stretch:1.12,tail:.06},
  {at:CAT_HOP.land,front:[.97,-.40],hind:[-.54,1.21],stretch:1.06,tail:.18},
  {at:CAT_HOP.absorb,front:[1.42,-1.65],hind:[-.62,1.13],stretch:1.01,tail:.21},
  {at:.825,front:[1.12,-1.91],hind:[-.52,.69],stretch:.94,tail:.16},
  {at:CAT_HOP.hindDown,front:[.60,-1.32],hind:[-.38,.35],stretch:.96,tail:.12},
  {at:1,...catIdlePose},
];
const catHopSpline=new THREE.CubicInterpolant(
  Float32Array.from(catHopPoses,pose=>pose.at),
  Float32Array.from(catHopPoses.flatMap(pose=>[...pose.front,...pose.hind,pose.stretch,pose.tail])),
  6,
);
catHopSpline.settings={endingStart:THREE.ZeroSlopeEnding,endingEnd:THREE.ZeroSlopeEnding};

function catHopPitch(progress) {
  const {smoothstep}=THREE.MathUtils;
  const climb=smoothstep(progress,CAT_HOP.crouch,CAT_HOP.launch)*(1-smoothstep(progress,CAT_HOP.climbEnd,CAT_HOP.levelStart));
  const dive=smoothstep(progress,CAT_HOP.levelEnd,CAT_HOP.land)*(1-smoothstep(progress,CAT_HOP.absorb,CAT_HOP.hindDown));
  return .72*climb-.68*dive;
}

const rearPawAngle=Math.atan2(rearleg.pawX,-rearleg.pawY);

function authoredForePaw(shoulder,bend) {
  // Keep the paw targets authored for the original two-segment rig.
  const pitch=shoulder+bend;
  const cos=Math.cos(pitch),sin=Math.sin(pitch);
  return {
    x:rearleg.upper*Math.sin(shoulder)+rearleg.pawX*cos-rearleg.pawY*sin,
    down:rearleg.upper*Math.cos(shoulder)-rearleg.pawX*sin-rearleg.pawY*cos,
    pitch,
  };
}

const foreIdlePaw=authoredForePaw(...catIdlePose.front);

function poseForeleg(leg,x,down,wristPitch,toePitch) {
  const {upper,forearm,toeX,toeY}=foreleg;
  const cos=Math.cos(wristPitch),sin=Math.sin(wristPitch);
  const wristX=x-toeX*cos+toeY*sin;
  const wristDown=down+toeX*sin+toeY*cos;
  const elbowCos=(wristX*wristX+wristDown*wristDown-upper*upper-forearm*forearm)/(2*upper*forearm);
  const elbow=Math.acos(THREE.MathUtils.clamp(elbowCos,-1,1));
  const shoulder=Math.atan2(wristX,wristDown)-Math.atan2(forearm*Math.sin(elbow),upper+forearm*Math.cos(elbow));
  leg.pivot.rotation.z=shoulder;
  leg.lower.rotation.z=elbow;
  leg.wrist.rotation.z=wristPitch-shoulder-elbow;
  leg.paw.rotation.z=toePitch-wristPitch;
}

function poseHopLeg(leg,pose,air,pouncing,reach=0,sniff=0,extension=1) {
  const {lerp}=THREE.MathUtils;
  const joint=leg.front?0:2;
  const offset=leg.front?.065:.095;
  const idle=leg.front?catIdlePose.front:catIdlePose.hind;
  const shoulder=lerp(idle[0],pose[joint],extension)+leg.side*offset*air+(pouncing?(leg.front?.055:-.08)*air:0);
  const bend=lerp(idle[1],pose[joint+1],extension)-leg.side*(leg.front?.06:.11)*air;
  if(leg.front) {
    const paw=authoredForePaw(shoulder+.22*sniff,bend-.36*sniff);
    poseForeleg(leg,paw.x,paw.down,lerp(paw.pitch+rearPawAngle,1.05,reach),lerp(paw.pitch,-.12,reach));
  } else {
    leg.pivot.rotation.z=shoulder;
    leg.lower.rotation.z=bend;
    leg.paw.rotation.z=reach*(-1.22-shoulder-bend);
  }
}

function measurePawSupport(cat) {
  cat.root.updateMatrixWorld(true);
  let lowest=Infinity;
  for(const leg of cat.legs) {
    const matrix=leg.paw.matrixWorld;
    const m=matrix.elements;
    const radius=Math.hypot(m[1],m[5],m[9]);
    leg.sole.set(-m[1]/radius,-m[5]/radius,-m[9]/radius).applyMatrix4(matrix);
    lowest=Math.min(lowest,leg.sole.y);
  }
  return -lowest;
}

function hopSupportAt(cat,progress) {
  cat.bodyPivot.rotation.z=catHopPitch(progress);
  const pose=catHopSpline.evaluate(progress);
  for(const leg of cat.legs)poseHopLeg(leg,pose,0,false);
  return measurePawSupport(cat);
}

function catNoise(cycle,catIndex,channel=0) {
  let hash=Math.imul(cycle+1,0x9e3779b1)^Math.imul(catIndex+1,0x85ebca6b)^Math.imul(channel,0x27d4eb2d)^catRoutineSeed;
  hash=Math.imul(hash^(hash>>>16),0x45d9f3b);
  return ((hash^(hash>>>16))>>>0)/4294967296;
}

function shuffleCatRoutines(block,index) {
  const order=[...catRoutines];
  for(let i=order.length-1;i>0;i--) {
    const j=Math.floor(catNoise(block,index,i+1)*(i+1));
    [order[i],order[j]]=[order[j],order[i]];
  }
  return order;
}

function catRoutineAt(cycle,index) {
  const block=Math.floor(cycle/catRoutines.length);
  if(catRoutineOrders[index]?.block!==block) {
    const order=shuffleCatRoutines(block,index);
    // Avoid consecutive repeats at a shuffle boundary as well as within a block.
    if(block>0&&order[0]===shuffleCatRoutines(block-1,index).at(-1)) {
      [order[0],order[1]]=[order[1],order[0]];
    }
    catRoutineOrders[index]={block,order};
  }
  return catRoutineOrders[index].order[cycle%catRoutines.length];
}

function snowCoverAt(x,z) {
  const current=Math.floor(phase)%4;
  if(current!==3&&current!==0)return 0;
  const sweep=fract(phase);
  if(sweep<=.000001)return current===0?1:0;
  // Match seasonCoverage so paw contacts follow the rendered snow line.
  const angle=Math.atan2(z,x)/TAU;
  const arc=TAU*Math.max(Math.hypot(x,z),.96);
  const offset=Math.abs(fract(angle-.5*sweep+.5)-.5);
  const distance=(.5*sweep-offset)*arc;
  const feather=Math.min(SEASON_BLEND_WIDTH,arc*.35*Math.min(sweep,1-sweep));
  const contour=.34*Math.sin(x*1.5+z*1.9+.3)+.21*Math.sin(z*4.1-x*2.7-1);
  const {smoothstep,lerp}=THREE.MathUtils;
  const covered=smoothstep(distance+feather*contour,-feather,feather);
  const winter=current===3?1:0;
  const cover=winter?covered:1-covered;
  if(sweep<SNOW_WRAP_TURNS)return lerp(1-winter,cover,smoothstep(sweep,0,SNOW_WRAP_TURNS));
  if(sweep>1-SNOW_WRAP_TURNS)return lerp(cover,winter,smoothstep(sweep,1-SNOW_WRAP_TURNS,1));
  return cover;
}

function snowDepthAt(x,z,cover) {
  if(cover<=.02)return 0;
  const {smoothstep,lerp}=THREE.MathUtils;
  // Match the accumulation curve in the snow mesh for paw height.
  const turn=fract(Math.atan2(z,x)/TAU);
  const age=(phase<1?phase+1:phase-3)-turn;
  let mature=smoothstep(age,0,SNOW_BUILD_TURNS);
  const seam=SNOW_SEAM_WIDTH/(TAU*Math.max(Math.hypot(x,z),.96));
  const fromSeam=Math.min(turn,1-turn);
  if(fromSeam<seam) {
    const otherAge=age+(turn<.5?-1:1);
    mature=lerp(mature,smoothstep(otherAge,0,SNOW_BUILD_TURNS),.5*(1-smoothstep(fromSeam,0,seam)));
  }
  return smoothstep(cover,.02,.98)*lerp(SNOW_DUST_DEPTH,1,mature);
}

const rearLowerLeg=Math.hypot(rearleg.pawX,rearleg.pawY);
const walkTailAngles=[-.98,-.11,.24,.10];
const sitTailAngles=[[1.28,.28],[.42,-.24],[.36,-.14],[.22,.06]];

function poseSittingLeg(leg,bodyPivot,sitting) {
  const {lerp}=THREE.MathUtils;
  if(!leg.front) {
    // Fold the rear legs under the haunches before lowering the pelvis fully.
    const fold=sitting*(2-sitting);
    leg.pivot.rotation.z=lerp(catIdlePose.hind[0],.745,fold);
    leg.lower.rotation.z=lerp(catIdlePose.hind[1],-2.768,fold);
    leg.paw.rotation.z=1.283*sitting;
    return;
  }
  const pitch=bodyPivot.rotation.z;
  const targetX=lerp(foreleg.shoulderX+foreIdlePaw.x,.191,sitting);
  const targetY=lerp(catLegY-foreIdlePaw.down,CAT_REST.floor+leg.paw.scale.y,sitting)-bodyPivot.position.y;
  const cos=Math.cos(pitch),sin=Math.sin(pitch);
  const x=cos*targetX+sin*targetY-leg.pivot.position.x;
  const down=leg.pivot.position.y-bodyPivot.position.y+sin*targetX-cos*targetY;
  poseForeleg(leg,x,down,lerp(foreIdlePaw.pitch+rearPawAngle,.22-pitch,sitting),lerp(foreIdlePaw.pitch,-pitch,sitting));
}

function poseWalkingLeg(leg,bodyPivot,step,stride,weight,down,swingHeight) {
  const {clamp,lerp,smoothstep}=THREE.MathUtils;
  const stepPhase=fract(step+(leg.front?0:.25)+(leg.side===1?.5:0));
  const stance=.64;
  const swing=clamp((stepPhase-stance)/(1-stance),0,1);
  const lift=Math.sin(Math.PI*swing)**2;
  // The stance target stays put as the torso moves. During swing it eases to the next print.
  const offset=stance*.5-stepPhase+smoothstep(swing,0,1);
  const joint=leg.pivot.position;
  const targetX=joint.x+(leg.front?.026:-.011)+stride*offset;
  const targetY=joint.y-down+swingHeight*lift-bodyPivot.position.y+leg.paw.scale.y-rearleg.padHeight;
  const pitch=bodyPivot.rotation.z;
  const cos=Math.cos(pitch),sin=Math.sin(pitch);
  const x=cos*targetX+sin*targetY-joint.x;
  const y=joint.y-bodyPivot.position.y+sin*targetX-cos*targetY;
  if(leg.front) {
    const wristPitch=.16+.85*(Math.atan2(x,y)+pitch)-.96*lift;
    const toePitch=lerp(-.85,.25,swing)*lift;
    poseForeleg(leg,lerp(foreIdlePaw.x,x,weight),lerp(foreIdlePaw.down,y,weight),
      lerp(foreIdlePaw.pitch+rearPawAngle,wristPitch-pitch,weight),lerp(foreIdlePaw.pitch,toePitch-pitch,weight));
    return;
  }
  const kneeCos=(x*x+y*y-rearleg.upper**2-rearLowerLeg**2)/(2*rearleg.upper*rearLowerLeg);
  const knee=Math.acos(clamp(kneeCos,-1,1));
  const hip=Math.atan2(x,y)-Math.atan2(rearLowerLeg*Math.sin(knee),rearleg.upper+rearLowerLeg*Math.cos(knee));
  const idle=catIdlePose.hind;
  leg.pivot.rotation.z=lerp(idle[0],hip,weight);
  leg.lower.rotation.z=lerp(idle[1],knee-rearPawAngle,weight);
  const toePitch=lerp(-.55,.32,swing)*lift;
  leg.paw.rotation.z=weight*(toePitch-pitch-leg.pivot.rotation.z-leg.lower.rotation.z);
}

function catRoutineWait(cycle,index) { return .32+1.32*index+.76*catNoise(cycle,index); }

function catMotionAt(index,atTime) {
  const {lerp,clamp,smoothstep}=THREE.MathUtils;
  atTime=Math.max(0,atTime);
  const cycle=Math.floor(atTime/CAT_CYCLE_SECONDS);
  const point=(cycle+index*2)%catLandings.length;
  const localTime=atTime-cycle*CAT_CYCLE_SECONDS;
  const routine=catRoutineAt(cycle,index);
  const wait=catRoutineWait(cycle,index);
  const elapsed=localTime-wait;
  const restStart=wait+routine.seconds+CAT_REST.prepare;
  const riseStart=CAT_CYCLE_SECONDS-1.10-.65*catNoise(cycle,index,5)-.38*(1-index);
  const sitting=smoothstep(localTime,restStart,restStart+CAT_REST.lower)*(1-smoothstep(localTime,riseStart,riseStart+CAT_REST.rise));
  const beat=routine.segments.find(segment=>elapsed<segment.end)??routine.segments.at(-1);
  const progress=clamp((elapsed-beat.start)/(beat.end-beat.start),0,1);
  const walking=beat.kind==='walk'||beat.kind==='stalk';
  const hopping=beat.kind==='jump'||beat.kind==='pounce';
  const flight=hopping?clamp((progress-CAT_HOP.launch)/(CAT_HOP.land-CAT_HOP.launch),0,1):0;
  const advance=walking?smoothstep(progress,.12,.9):flight;
  const travel=lerp(beat.from,beat.to,advance);
  const from=catLandings[point];
  const to=catLandings[(point+1)%catLandings.length];
  const next=catLandings[(point+2)%catLandings.length];
  const x=lerp(from.x,to.x,travel), z=lerp(from.z,to.z,travel);
  const dx=to.x-from.x, dz=to.z-from.z;
  const distance=Math.hypot(dx,dz)*(beat.to-beat.from);
  const heading=-Math.atan2(dz,dx);
  const nextHeading=-Math.atan2(next.z-to.z,next.x-to.x);
  const turn=Math.atan2(Math.sin(nextHeading-heading),Math.cos(nextHeading-heading));
  const hopGaze=hopping&&beat.to===1?turn*.31*smoothstep(progress,.47,.70)*(1-smoothstep(progress,.79,1)):0;
  return {kind:beat.kind,progress,sitting,x,z,distance,flight,hopGaze,turn,
    heading:heading+turn*smoothstep(localTime,wait+routine.moveEnd,restStart)};
}

function nextCatTravel(index,after) {
  const first=Math.floor(Math.max(0,after)/CAT_CYCLE_SECONDS);
  for(let cycle=first;cycle<=first+1;cycle++) {
    const startOfRoutine=cycle*CAT_CYCLE_SECONDS+catRoutineWait(cycle,index);
    for(const beat of catRoutineAt(cycle,index).segments) {
      const start=startOfRoutine+beat.start;
      if(start<after||beat.from===beat.to)continue;
      const end=startOfRoutine+beat.end;
      return {kind:beat.kind,start,end,target:catMotionAt(index,end)};
    }
  }
  return null;
}

const foxtailJumpPlans=[new Map(),new Map()];
const catGlancePlans=new Map();
const CAT_GLANCE_BLOCK=CAT_CYCLE_SECONDS*2;
const CAT_GLANCE_SECONDS=2.15;
const CAT_GLANCE_OPEN=5.8;
const CAT_GLANCE_CLOSE=CAT_GLANCE_BLOCK-1.55;
const needleAngleAt=atTime=>fract(needlePhaseOffset+(atTime+catTimeOffset)*phaseRate)*TAU;

function resetFoxtailPlans() {
  needlePhaseOffset=phase-time*phaseRate;
  for(const plans of foxtailJumpPlans)plans.clear();
  catGlancePlans.clear();
}

function foxtailMotionAt(index,atTime) {
  const cache=foxtailJumpPlans[index];
  // A maneuver can begin in one cycle and finish in the next.
  const first=Math.floor((atTime-foxtailJumpWindow.after)/CAT_CYCLE_SECONDS);
  const last=Math.floor((atTime+foxtailJumpWindow.before)/CAT_CYCLE_SECONDS);
  for(let cycle=first;cycle<=last;cycle++) {
    if(!cache.has(cycle)) {
      const start=cycle*CAT_CYCLE_SECONDS;
      const plans=planFoxtailJumps(t=>catMotionAt(index,t),t=>nextCatTravel(index,t),needleAngleAt,
        start,start+CAT_CYCLE_SECONDS,CAT_HOP,SETTINGS.radius);
      if(cache.size>=5)cache.delete(cache.keys().next().value);
      cache.set(cycle,plans);
    }
    const plan=cache.get(cycle).find(item=>item.start>=firstFoxtailPlan&&atTime>=item.start&&atTime<item.end);
    if(plan)return foxtailJumpAction(plan,atTime,CAT_HOP);
  }
  return null;
}

function catLookAngle(from,to,heading) {
  const relative=-Math.atan2(to.z-from.z,to.x-from.x)-heading;
  return Math.atan2(Math.sin(relative),Math.cos(relative));
}

function planCatGlance(block) {
  const start=block*CAT_GLANCE_BLOCK;
  let settledAt=null,alignedAt=null,overShoulder=null;
  for(let t=start+CAT_GLANCE_OPEN;t<start+CAT_GLANCE_CLOSE;t+=.22) {
    const black=foxtailMotionAt(0,t)??catMotionAt(0,t);
    const white=foxtailMotionAt(1,t)??catMotionAt(1,t);
    const distance=Math.hypot(white.x-black.x,white.z-black.z);
    const blackAngle=Math.abs(catLookAngle(black,white,black.heading));
    const whiteAngle=Math.abs(catLookAngle(white,black,white.heading));
    const nearby=distance>.73&&distance<2.10;
    const fartherAngle=Math.max(blackAngle,whiteAngle);
    if(black.sitting<.995||white.sitting<.995||!nearby||Math.min(blackAngle,whiteAngle)>=1.20||fartherAngle>=2.39) {
      settledAt=alignedAt=null;
      continue;
    }
    const first=blackAngle<whiteAngle?0:1;
    settledAt??=t;
    if(!overShoulder&&t-settledAt>=CAT_GLANCE_SECONDS+.12)overShoulder={start:settledAt+.07,first};
    if(fartherAngle>=1.92) {
      alignedAt=null;
      continue;
    }
    alignedAt??=t;
    if(t-alignedAt>=CAT_GLANCE_SECONDS+.12)return {start:alignedAt+.07,first};
  }
  return overShoulder;
}

const glanceAxis=new THREE.Vector3(0,1,0);
const glanceHead=new THREE.Quaternion(), glanceBody=new THREE.Quaternion();

function applyCatGlance(atTime) {
  const block=Math.floor(atTime/CAT_GLANCE_BLOCK);
  const local=atTime-block*CAT_GLANCE_BLOCK;
  if(local<CAT_GLANCE_OPEN||local>=CAT_GLANCE_CLOSE)return;
  if(!catGlancePlans.has(block)) {
    if(catGlancePlans.size>=3)catGlancePlans.delete(catGlancePlans.keys().next().value);
    catGlancePlans.set(block,planCatGlance(block));
  }
  const event=catGlancePlans.get(block);
  if(!event||atTime<event.start||atTime>event.start+CAT_GLANCE_SECONDS)return;
  const {smoothstep,clamp}=THREE.MathUtils;
  for(const [index,cat] of cats.entries()) {
    const elapsed=atTime-event.start-(index===event.first?0:.25);
    const listen=smoothstep(elapsed,0,.24)*(1-smoothstep(elapsed,1.52,1.90));
    const look=smoothstep(elapsed,.11,.57)*(1-smoothstep(elapsed,1.36,1.88));
    const peer=cats[1-index];
    const yaw=catLookAngle(cat.root.position,peer.root.position,cat.root.rotation.y);
    const direction=Math.sign(yaw);
    for(const {joint,side} of cat.ears)joint.rotation.y+=direction*listen*(side===-direction?.29:.17);
    if(look<=0)continue;
    // Counter the seated torso pitch so the head turns toward the other cat at eye level.
    glanceHead.setFromAxisAngle(glanceAxis,clamp(yaw,-1.48,1.48));
    glanceHead.premultiply(glanceBody.copy(cat.bodyPivot.quaternion).invert());
    cat.head.quaternion.slerp(glanceHead,look);
    cat.head.position.y+=.017*look;
    cat.body.rotation.y=.10*look*direction;
  }
}

const TIMELAPSE_SPEED=4;
const TIMELAPSE_INTERVAL=14;

function normalCatMotion(index,atTime) {
  return foxtailMotionAt(index,atTime)??catMotionAt(index,atTime);
}

function idleMotion(point,sitting,heading=point.heading) {
  return {...point,kind:'idle',progress:0,distance:0,sitting,heading,hopGaze:0,turn:0};
}

// A change of resting spot uses the existing paw targets and walking rig.
function walkBetween(from,to,elapsed,duration) {
  const {lerp,smoothstep,clamp}=THREE.MathUtils;
  const dx=to.x-from.x,dz=to.z-from.z;
  const distance=Math.hypot(dx,dz);
  const heading=distance>.005?-Math.atan2(dz,dx):from.heading;
  if(elapsed<.70) {
    const rise=smoothstep(elapsed,0,.70);
    const turn=Math.atan2(Math.sin(heading-from.heading),Math.cos(heading-from.heading));
    return idleMotion(from,from.sitting*(1-rise),from.heading+turn*rise);
  }
  const progress=clamp((elapsed-.70)/duration,0,1);
  const advance=smoothstep(progress,.12,.9);
  if(progress<1) {
    return {kind:'walk',progress,distance,sitting:0,heading,x:lerp(from.x,to.x,advance),z:lerp(from.z,to.z,advance)};
  }
  const settle=smoothstep(elapsed,.70+duration,1.50+duration);
  const turn=Math.atan2(Math.sin(to.heading-heading),Math.cos(to.heading-heading));
  return idleMotion(to,to.sitting*settle,heading+turn*settle);
}

function calmCatMotion(index,elapsed) {
  const {entry,spots}=timelapse.cats[index];
  const sinceMove=elapsed-(index===0?4.2:10.8);
  if(sinceMove<0) {
    const settle=THREE.MathUtils.smoothstep(elapsed,.12,.96);
    return idleMotion(entry,THREE.MathUtils.lerp(entry.sitting,1,settle));
  }
  const move=Math.floor(sinceMove/TIMELAPSE_INTERVAL);
  return walkBetween(spots[move%2],spots[(move+1)%2],sinceMove%TIMELAPSE_INTERVAL,1.32);
}

function catAnimationTime(sceneTime) {
  if(!timelapse||sceneTime<timelapse.start)return sceneTime-catTimeOffset;
  const {start,normalTime,exit}=timelapse;
  if(exit&&sceneTime>=exit.start) {
    return normalTime+(exit.start-start)/TIMELAPSE_SPEED+(sceneTime-exit.start)/exit.speed;
  }
  return normalTime+(sceneTime-start)/TIMELAPSE_SPEED;
}

function activeCatMotion(index,sceneTime) {
  if(!timelapse||sceneTime<timelapse.start)return normalCatMotion(index,sceneTime-catTimeOffset);
  const {start,exit}=timelapse;
  if(exit&&sceneTime>=exit.start) {
    const cat=exit.cats[index];
    return walkBetween(cat.from,cat.to,(sceneTime-exit.start)/exit.speed,exit.duration);
  }
  return calmCatMotion(index,(sceneTime-start)/TIMELAPSE_SPEED);
}

function snowTravelMotion(motion) {
  const {kind,progress,distance,heading,x,z,poseWeight=1}=motion;
  if((kind!=='walk'&&kind!=='stalk')||motion.sitting>0||distance<.025||progress<=0||progress>=1)return motion;
  const {lerp,smoothstep,clamp}=THREE.MathUtils;
  const hops=Math.max(2,Math.round(distance/.26));
  const step=clamp((progress-.12)/(.9-.12),0,1)*hops;
  const index=Math.min(hops-1,Math.floor(step));
  const hopProgress=step-index;
  const advance=smoothstep(progress,.12,.9);
  const start=smoothstep(.12+(.9-.12)*index/hops,.12,.9);
  const end=smoothstep(.12+(.9-.12)*(index+1)/hops,.12,.9);
  const dx=Math.cos(heading)*distance, dz=-Math.sin(heading)*distance;
  const cover=snowCoverAt(x,z);
  if(cover<.55)return motion;
  const depth=snowDepthAt(x,z,cover);
  const snowHop=poseWeight*smoothstep(cover,.55,.79)*smoothstep(depth,.17,.35);
  if(snowHop<=0)return motion;
  const flight=clamp((hopProgress-CAT_HOP.launch)/(CAT_HOP.land-CAT_HOP.launch),0,1);
  const offset=lerp(start,end,flight)-advance;
  return {...motion,x:x+dx*offset*snowHop,z:z+dz*offset*snowHop,snowHop,hopProgress};
}

function updatePlaybackMode() {
  if(timelapse?.exit) {
    const {exit}=timelapse;
    if(time<exit.start+(exit.duration+1.50)*exit.speed)return;
    catTimeOffset=time-exit.resumeAt;
    firstFoxtailPlan=exit.resumeAt;
    timelapse=null;
    resetFoxtailPlans();
  }
  if(requestedSpeed===TIMELAPSE_SPEED&&!timelapse) {
    const normalTime=time-catTimeOffset;
    const entries=cats.map((_,index)=>snowTravelMotion(normalCatMotion(index,normalTime)));
    // Finish the current jump, including its landing pose.
    if(entries.some(m=>{
      const hopping=m.snowHop>.35||['jump','pounce','poleJump'].includes(m.kind);
      const progress=m.hopProgress??m.progress;
      return hopping&&progress>CAT_HOP.launch&&progress<CAT_HOP.hindDown;
    }))return;
    timelapse={start:time,normalTime,cats:entries.map((entry,index)=>{
      const peer=entries[1-index];
      const heading=-Math.atan2(entry.z-peer.z,entry.x-peer.x);
      const other={x:entry.x+Math.cos(heading)*.61,z:entry.z-Math.sin(heading)*.61,sitting:1,heading};
      return {entry,spots:[idleMotion(entry,1),other]};
    })};
  } else if(requestedSpeed!==TIMELAPSE_SPEED&&timelapse) {
    const elapsed=(time-timelapse.start)/TIMELAPSE_SPEED;
    const from=cats.map((_,index)=>calmCatMotion(index,elapsed));
    if(from.some(m=>m.sitting<.999))return;
    let resumeAt=Math.ceil(timelapse.normalTime/CAT_CYCLE_SECONDS)*CAT_CYCLE_SECONDS;
    let targets=cats.map((_,index)=>catMotionAt(index,resumeAt));
    // Rejoin the ordinary route at a quiet moment close to the entry positions.
    for(let delay=0;delay<4;delay+=.10) {
      const candidate=timelapse.normalTime+delay;
      const poses=cats.map((_,index)=>catMotionAt(index,candidate));
      if(poses.every(m=>m.sitting>.999||m.progress===0||m.progress===1)) {
        resumeAt=candidate;
        targets=poses;
        break;
      }
    }
    const distance=Math.max(...targets.map((m,i)=>Math.hypot(m.x-from[i].x,m.z-from[i].z)));
    timelapse.exit={start:time,resumeAt,speed:requestedSpeed,duration:Math.max(1.05,distance/.75),
      cats:targets.map((to,i)=>({from:from[i],to}))};
  }
  speed=requestedSpeed;
}

function animateCat(cat,index,sceneTime) {
  const {lerp,clamp,smoothstep}=THREE.MathUtils;
  const motion=snowTravelMotion(activeCatMotion(index,sceneTime));
  const atTime=catAnimationTime(sceneTime);
  const {kind,progress,sitting,x,z,distance,heading,turn=0,hopGaze=0,poseWeight=1,snowHop=0,hopProgress=progress}=motion;
  const stalking=kind==='stalk';
  const walking=kind==='walk'||stalking;
  const pouncing=kind==='pounce';
  const poleJump=kind==='poleJump';
  const hopping=kind==='jump'||pouncing||poleJump||snowHop>0;
  const flight=hopping?clamp((hopProgress-CAT_HOP.launch)/(CAT_HOP.land-CAT_HOP.launch),0,1):0;
  const advance=walking?smoothstep(progress,.12,.9):flight;
  const snowDepth=snowDepthAt(x,z,snowCoverAt(x,z));
  const hopHeight=snowHop>0?.14*snowHop:(poleJump?foxtailJumpHeight:pouncing?.39:.67)+.09*distance;
  cat.flight=flight;
  cat.snowHop=snowHop;
  cat.airHeight=4*hopHeight*flight*(1-flight);
  cat.root.rotation.y=heading;
  cat.root.position.set(x,0,z);

  const gesture=Math.sin(Math.PI*progress)**2*poseWeight;
  const peek=kind==='peek'?gesture:0;
  const sniff=kind==='sniff'?gesture:0;
  const scan=kind==='scan'?gesture:0;

  const air=Math.sin(Math.PI*flight);
  const reach=hopping?smoothstep(hopProgress,.34,CAT_HOP.levelStart)*(1-smoothstep(hopProgress,CAT_HOP.levelEnd,.65))*(1-.55*snowHop):0;
  const landing=hopping?smoothstep(hopProgress,CAT_HOP.land,CAT_HOP.absorb)*(1-smoothstep(hopProgress,.825,.95)):0;
  const walkWeight=walking?poseWeight*smoothstep(progress,.025,.17)*(1-smoothstep(progress,.85,.99)):0;
  const crouch=stalking?walkWeight:0;
  const strides=Math.max(1,Math.ceil(distance/(stalking?.23:.28)));
  const step=advance*strides;
  const stride=distance/(strides*cat.root.scale.x);
  const strideWave=Math.sin(TAU*step);
  const walkBob=Math.cos(2*TAU*step);
  const walkDown=.262+.006*walkBob-.041*crouch;
  const tailLift=walkWeight-.76*crouch;
  const hopPose=catHopSpline.evaluate(hopping?hopProgress:0);
  const walkPitch=(-.025+.018*strideWave)*walkWeight;
  const jumpPitch=catHopPitch(hopping?hopProgress:0);
  const pitch=(walking?lerp(walkPitch,jumpPitch*.44,snowHop):jumpPitch)+.10*peek-.13*sniff-.07*crouch*(1-snowHop)+CAT_REST.pitch*sitting;
  cat.bodyPivot.rotation.z=pitch;
  cat.bodyPivot.rotation.x=walking?.026*walkWeight*strideWave*(1-snowHop):.035*air*Math.sin(TAU*flight+index);
  const breath=lerp(.013,.006,sitting)*Math.sin(atTime*3.3+index*1.65);
  const stretch=walking?lerp(1+.013*walkWeight*strideWave,lerp(1,hopPose[4],.60),snowHop):hopPose[4];
  cat.body.scale.set(stretch-.20*sitting,1+breath-.05*sniff-.065*landing,1+breath+.055*sitting);
  cat.body.rotation.y=0;
  let restGaze=0,tailSide=1;
  if(sitting>0) {
    const viewer=-Math.atan2(camera.position.z-z,camera.position.x-x)-cat.root.rotation.y;
    const side=Math.sin(viewer);
    restGaze=clamp(Math.atan2(side,Math.cos(viewer)),-.63,.63)*sitting;
    tailSide=side>0?-1:1;
  }
  const gaze=restGaze+scan*.68*Math.sin(TAU*progress+index*1.5)+.12*tailLift*Math.sin(TAU*progress+index)+hopGaze*poseWeight;
  const headX=.295+.025*reach+.049*sniff+.018*walkWeight+.015*sitting;
  const headY=.48-.073*reach+.065*peek+.035*scan-.084*sniff+(.019-.007*walkBob)*walkWeight-.043*crouch-.022*sitting;
  cat.head.position.set(headX,headY,0);
  cat.head.rotation.set(.07*scan*Math.sin(TAU*progress),gaze,-pitch*(.32+.68*sitting)-.18*reach-.49*sniff+.15*peek+.04*sniff*Math.sin(atTime*17)-.08*crouch);
  for(const {joint,side} of cat.ears) {
    const activeFlick=Math.max(0,Math.sin(atTime*3.8+side*1.7+index))**10;
    const restFlick=.60*Math.max(0,Math.sin(atTime*1.25+side*1.7+index))**24;
    const flick=lerp(activeFlick,restFlick,sitting);
    joint.rotation.set(side*(.15+.12*flick),side*.16+.40*gaze,.04+.34*reach+.12*peek-.10*sniff);
  }
  cat.tailBones.forEach((bone,joint)=>{
    const wave=atTime*2.9+index*1.7-joint*.62;
    const yaw=Math.sin(wave)*(.09+.036*joint)*(1+.50*scan)+.05*turn*air;
    const tailPitch=(joint===0?hopPose[5]:.032*Math.sin(wave))+tailLift*walkTailAngles[joint]-.055*peek+.05*sniff;
    bone.rotation.y=lerp(yaw,sitTailAngles[joint][0]*tailSide,sitting);
    const restPitch=sitTailAngles[joint][1]-(joint===0?.24*snowDepth:0);
    bone.rotation.z=lerp(tailPitch,restPitch,sitting);
  });
  for(const leg of cat.legs) {
    if(leg.front) {
      leg.pivot.position.x=lerp(foreleg.shoulderX,.142,sitting);
      leg.pivot.position.y=lerp(catLegY,.29,sitting);
    }
    if(sitting>0)poseSittingLeg(leg,cat.bodyPivot,sitting);
    else if(walking&&snowHop<.999) {
      poseWalkingLeg(leg,cat.bodyPivot,step,stride,walkWeight,walkDown,.064-.017*crouch);
      if(snowHop>0) {
        const hip=leg.pivot.rotation.z,knee=leg.lower.rotation.z,paw=leg.paw.rotation.z;
        const wrist=leg.wrist?.rotation.z;
        poseHopLeg(leg,hopPose,air,false,reach,0,.60);
        leg.pivot.rotation.z=lerp(hip,leg.pivot.rotation.z,snowHop);
        leg.lower.rotation.z=lerp(knee,leg.lower.rotation.z,snowHop);
        leg.paw.rotation.z=lerp(paw,leg.paw.rotation.z,snowHop);
        if(leg.wrist)leg.wrist.rotation.z=lerp(wrist,leg.wrist.rotation.z,snowHop);
      }
    } else poseHopLeg(leg,hopPose,air,pouncing,reach,sniff,snowHop>0?.60:1);
  }

  cat.snowLift=snowDepth*.065;
  cat.contactWeight=.38+.24*landing;
}

let lastTrampleTime=null;
let pawContacts=[];
function poseAndStampCats(atTime) {
  const contacts=[];
  cats.forEach((cat,index)=>{
    animateCat(cat,index,atTime);
    const airborne=cat.flight>0&&cat.flight<1;
    const offGround=airborne&&(cat.snowHop===0||cat.snowHop>.35);
    let support=measurePawSupport(cat);
    if(cat.snowHop>0) {
      support+=cat.airHeight;
    } else if(airborne) {
      // Connect the push-off and touchdown heights with a single arc independent of leg motion.
      const base=THREE.MathUtils.lerp(cat.takeoffSupport,cat.landingSupport,cat.flight);
      support=Math.max(support,base+cat.airHeight);
    }
    const lift=cat.snowLift+.018+support;
    cat.root.position.y=lift;
    const headingX=Math.cos(cat.root.rotation.y),headingZ=-Math.sin(cat.root.rotation.y);
    cat.legs.forEach((leg,pawIndex)=>{
      const {x,y,z}=leg.sole;
      const height=y+lift-cat.snowLift;
      const force=offGround?0:cat.contactWeight*(1-THREE.MathUtils.smoothstep(height,.018,.075));
      contacts.push({cat:index,paw:pawIndex,x,z,height,force});
      const snow=snowCoverAt(x,z);
      const depth=snowDepthAt(x,z,snow);
      const snowContact=!offGround&&snow>.55&&depth>.20&&height<.043;
      if(snowContact&&!leg.snowContact)trampleField.stamp(x,z,headingX,headingZ,.105,.074,.95,true);
      leg.snowContact=snowContact;
      trampleField.stamp(x,z,headingX,headingZ,.115,.090,force*(1-depth));
    });
  });
  pawContacts=contacts;
}
function updateTrampling(atTime) {
  const dt=lastTrampleTime===null?Infinity:atTime-lastTrampleTime;
  const seekThreshold=Math.max(.18,MAX_FRAME_SECONDS*speed+.001);
  if(dt<0||dt>seekThreshold) {
    trampleField.clear();
    for(const cat of cats)for(const leg of cat.legs)leg.snowContact=false;
    // Rebuild only the recent steps when seeking, without rendering the replay.
    const winter=Math.floor(phase)===3||Math.floor(phase)===0;
    const start=Math.max(0,atTime-(winter?24:4.8)),step=1/30;
    for(let t=start;t<atTime;t+=step) {
      trampleField.decay(step);poseAndStampCats(t);
    }
  } else {
    // Sample intermediate paw contacts when an accelerated frame spans a long step.
    const sampleInterval=phase<1||phase>3?1/24:2*MAX_FRAME_SECONDS;
    const steps=Math.max(1,Math.ceil(dt/sampleInterval));
    for(let i=1;i<=steps;i++) {
      trampleField.decay(dt/steps);
      if(i<steps)poseAndStampCats(lastTrampleTime+dt*i/steps);
    }
  }
  poseAndStampCats(atTime);
  trampleField.upload();lastTrampleTime=atTime;
}

function makeSummerBirds(count) {
  const traits=new Float32Array([.16,1.02,.69,.88,.33,.96,.88,.91,.43,1.04,.57,.86]);
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(count*3),3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aBird',new THREE.BufferAttribute(traits,2));
  const material=new THREE.ShaderMaterial({
    uniforms,transparent:true,depthWrite:false,
    vertexShader:`
      uniform float uTime; uniform float uPhase; uniform float uPointScale;
      attribute vec2 aBird;
      varying float vFlap; varying float vBank; varying float vAlpha;
      ${seasonGLSL}
      void main() {
        float seed=aBird.x;
        vec2 ground=position.xz;
        float radius=length(ground);
        float summer=seasons(ground,uPhase).y;
        vAlpha=smoothstep(.78,.98,summer)*(1.-smoothstep(5.03,5.31,radius))*(.78+.14*seed);
        vFlap=sin(uTime*(7.8+1.7*seed)+seed*TAU);
        vBank=.17*sin(uTime*.76+seed*TAU);
        vec4 view=modelViewMatrix*vec4(position,1.);
        gl_Position=projectionMatrix*view;
        gl_PointSize=19.8*aBird.y*uPointScale*17./-view.z;
      }`,
    fragmentShader:`
      varying float vFlap; varying float vBank; varying float vAlpha;
      float segmentDistance(vec2 p,vec2 a,vec2 b) {
        vec2 edge=b-a;
        return length(p-a-edge*clamp(dot(p-a,edge)/dot(edge,edge),0.,1.));
      }
      void main() {
        vec2 p=gl_PointCoord-.5;
        p=mat2(cos(vBank),-sin(vBank),sin(vBank),cos(vBank))*p;
        vec2 center=vec2(0.,.035);
        vec2 left=vec2(-.17,-.045+.075*vFlap), right=vec2(.15,-.032+.065*vFlap);
        float inner=min(segmentDistance(p,center,left),segmentDistance(p,center,right));
        float outer=min(segmentDistance(p,left,vec2(-.40,-.115+.19*vFlap)),
          segmentDistance(p,right,vec2(.37,-.105+.17*vFlap)));
        float alpha=vAlpha*max(1.-smoothstep(.027,.081,inner),.83*(1.-smoothstep(.014,.061,outer)));
        if(alpha<.035)discard;
        gl_FragColor=vec4(.88,.92,.83,alpha);
      }`,
  });
  const birds=new THREE.Points(geometry,material);
  birds.frustumCulled=false;
  scene.add(birds);
  return birds;
}

function makeParticles() {
  const geometry=new THREE.BufferGeometry();
  const count=SETTINGS.particles+1280;
  const seeds=new Float32Array(count*4);
  const autumnOnly=new Float32Array(count);
  for(let i=0;i<SETTINGS.particles;i++)seeds.set([random(),random(),random(),random()],i*4);
  const snowfallSeed=randomState;
  for(let i=SETTINGS.particles;i<count;i++)seeds.set([random(),random(),random(),random()],i*4);
  randomState=snowfallSeed;
  autumnOnly.fill(1,SETTINGS.particles);
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(count*3),3));
  geometry.setAttribute('aSeed',new THREE.BufferAttribute(seeds,4));
  geometry.setAttribute('aAutumnOnly',new THREE.BufferAttribute(autumnOnly,1));
  const material=new THREE.ShaderMaterial({
    uniforms,transparent:true,depthWrite:false,
    vertexShader:`
      uniform float uTime; uniform float uPhase; uniform float uPointScale;
      attribute vec4 aSeed; attribute float aAutumnOnly;
      varying float vAlpha; varying vec3 vColor; varying float vSpin;
      ${seasonGLSL}
      void main() {
        float age=fract(aSeed.z+uTime*(.045+aSeed.w*.036));
        float angle=aSeed.x*TAU;
        float r=sqrt(aSeed.y)*5.3;
        vec2 root=vec2(cos(angle),sin(angle))*r;
        vec4 s=seasons(root,uPhase);
        vec3 p=vec3(root.x,0.,root.y);
        p.y=.2+sin(age*3.14159)*(.35+aSeed.w*1.45);
        p.x+=sin(age*5.+aSeed.w*17.)*.24+age*.38;
        p.z+=cos(age*4.+aSeed.x*17.)*.26;
        p.xz+=vec2(1.8,1.15)*(age-.46)*s.z;
        p.y=mix(p.y,1.05+aSeed.w*.95-age*.72+.15*sin(age*6.+aSeed.x*TAU),s.z);
        float enabled=mix(dot(s,vec4(.27,.065,1.,0.)),s.z*.85,aAutumnOnly);
        float edge=1.-s.z*smoothstep(5.05,5.7,length(p.xz));
        vAlpha=sin(age*3.14159)*enabled*edge*(.5+aSeed.w*.5)*smoothstep(.8,1.2,r);
        vColor=mat4x3(vec3(.96,.87,.79),vec3(.75,.78,.47),vec3(.95,.74,.35),vec3(.76,.85,.91))*s;
        vSpin=aSeed.z*TAU+uTime*(.3+aSeed.w);
        vec4 view=modelViewMatrix*vec4(p,1.);
        gl_Position=projectionMatrix*view;
        gl_PointSize=(1.15+aSeed.w*3.8)*(1.08+.14*s.x+.18*s.z)*uPointScale*16./-view.z;
      }`,
    fragmentShader:`
      varying float vAlpha; varying vec3 vColor; varying float vSpin;
      void main() {
        vec2 p=gl_PointCoord-.5;
        p=mat2(cos(vSpin),-sin(vSpin),sin(vSpin),cos(vSpin))*p;
        float d=length(p*vec2(1.,2.2));
        float fringe=.20*(1.-smoothstep(.17,.49,length(p)));
        float a=max(1.-smoothstep(.18,.46,d),fringe)*vAlpha;
        if(a<.025)discard;
        gl_FragColor=vec4(vColor,a);
      }`,
  });
  const particles=new THREE.Points(geometry,material); particles.frustumCulled=false; scene.add(particles);
}

function makeSnowfall() {
  const seeds=new Float32Array(SETTINGS.snowflakes*4);
  for(let i=0;i<SETTINGS.snowflakes;i++)seeds.set([random(),random(),random(),random()],i*4);
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(SETTINGS.snowflakes*3),3));
  geometry.setAttribute('aSeed',new THREE.BufferAttribute(seeds,4));
  const material=new THREE.ShaderMaterial({
    uniforms,transparent:true,depthWrite:false,
    vertexShader:`
      uniform float uTime; uniform float uPhase; uniform float uPointScale;
      attribute vec4 aSeed; varying float vAlpha; varying float vSoftness;
      ${seasonGLSL}
      ${snowAccumulationGLSL}
      void main() {
        float age=fract(aSeed.z+uTime*(.065+aSeed.w*.055));
        float angle=aSeed.x*TAU, radius=sqrt(aSeed.y)*5.7;
        vec2 root=vec2(cos(angle),sin(angle))*radius;
        vec3 p=vec3(root.x,.12+(1.-age)*3.5,root.y);
        p.x+=sin(uTime*.55+aSeed.z*TAU)*(.06+aSeed.w*.12)+age*.16;
        p.z+=sin(uTime*.38+aSeed.w*TAU)*.10;
        float winter=softenSnowWrap(seasons(p.xz,uPhase).w,uPhase);
        float bounds=1.-smoothstep(5.25,5.7,length(p.xz));
        float fade=smoothstep(0.,.09,age)*(1.-smoothstep(.90,1.,age));
        vAlpha=winter*bounds*fade*(.56+aSeed.w*.44);
        vSoftness=aSeed.w;
        vec4 view=modelViewMatrix*vec4(p,1.);
        gl_Position=projectionMatrix*view;
        gl_PointSize=(1.25+pow(aSeed.w,2.)*3.85)*uPointScale*17./-view.z;
      }`,
    fragmentShader:`
      varying float vAlpha; varying float vSoftness;
      void main() {
        float distance=length(gl_PointCoord-.5);
        float alpha=(1.-smoothstep(.10,.50,distance))*vAlpha;
        if(alpha<.025)discard;
        gl_FragColor=vec4(mix(vec3(.84,.91,.98),vec3(1.),vSoftness),alpha);
      }`,
  });
  const snow=new THREE.Points(geometry,material);
  snow.frustumCulled=false; scene.add(snow);
  return snow;
}

function setupLights() {
  scene.add(new THREE.HemisphereLight('#afc4d1','#2b2a16',1.25));
  const sun=new THREE.DirectionalLight('#fff0ca',3.1); sun.position.set(-5,9,5); scene.add(sun);
  const rim=new THREE.DirectionalLight('#799cc5',3.); rim.position.set(3,3,-6); scene.add(rim);
  const soft=new THREE.DirectionalLight('#d0d7bf',.4); soft.position.set(0,2,8); scene.add(soft);
}

function resize() {
  const w=stage.clientWidth,h=stage.clientHeight;
  if(!w||!h)return;
  renderer.setSize(w,h,false);
  atmosphere.resize(canvas.width,canvas.height);
  uniforms.uPointScale.value=renderer.getPixelRatio()*w/1344;
  camera.aspect=w/h;
  // Preserve the whole disc on a narrow display, without stretching the circle.
  camera.fov=THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(27.5)/2)*Math.max(1,(16/9)/camera.aspect)));
  camera.updateProjectionMatrix();
  if(ready)render();
}
function updateUi(force=false) {
  const season=Math.floor(phase)%4;
  if(season!==lastSeason||force) {
    document.querySelector('#season-name').textContent=seasonNames[season];
    document.querySelector('#season-en').textContent=seasonEnglish[season];
    seasonButtons.forEach((button,i)=>button.setAttribute('aria-pressed',String(i===season)));
    lastSeason=season;
  }
  timeline.setAttribute('aria-valuetext',`${seasonNames[season]}，全年进度 ${Math.round(phase/4*100)}%`);
  timeline.value=String(Math.floor(phase*1000));
  timeline.style.setProperty('--progress',`${phase/4*100}%`);
}
function syncPause() {
  play.innerHTML=`<span aria-hidden="true">${paused?'▷':'Ⅱ'}</span>`;
  play.setAttribute('aria-label',paused?'继续动画':'暂停动画');
  play.setAttribute('aria-pressed',String(paused));
}
function setPhase(next) {
  phase=((next%4)+4)%4;
  resetFoxtailPlans();
  uniforms.uPhase.value=phase;
  updateUi(true);
  if(ready)render();
}
function render() {
  uniforms.uTime.value=time; uniforms.uPhase.value=phase;
  const needle=fract(phase)*TAU;
  uniforms.uNeedleDirection.value.set(Math.cos(needle),Math.sin(needle));
  foxtail.pivot.rotation.y=-needle;
  foxtail.pivot.rotation.z=Math.sin(time*.7)*.004;
  const bend=uniforms.uStemBend.value=-.035-.096*speed+Math.sin(time*1.65)*.018;
  const headAlong=foxtail.head.position.x/5.65;
  foxtail.head.position.z=.017+bend*headAlong*headAlong;
  foxtail.head.rotation.y=-Math.atan(2*bend*headAlong/5.65)+Math.sin(time*1.4)*.025;
  updateTrampling(time);
  if(!timelapse)applyCatGlance(time-catTimeOffset);
  uniforms.uCats.value.set(cats[0].root.position.x,cats[0].root.position.z,cats[1].root.position.x,cats[1].root.position.z);
  uniforms.uCatAir.value.set(cats[0].airHeight,cats[1].airHeight);
  snowCover.visible=snowfall.visible=phase<1||phase>3;
  flowers.visible=phase>0&&phase<3;
  summerBirds.visible=phase>summerFlight.start&&phase<summerFlight.end;
  if(summerBirds.visible) {
    const position=summerBirds.geometry.attributes.position;
    summerFlight.sample(phase,position.array);
    position.needsUpdate=true;
  }
  renderer.info.reset();
  renderer.render(scene,camera);
  atmosphere.render();
}
const fract=x=>x-Math.floor(x);

setupLights(); makeSky(); makeDisc(); makeGrass();
const flowers=makeFlowers();
const snowCover=makeSnowCover();
const foxtail=makeFoxtail();
const cats=[makeCat(false),makeCat(true)];
cats.forEach((cat,index)=>atmosphere.addCat(cat.root,index));
makeParticles();
const snowfall=makeSnowfall();
const summerFlight=buildSummerFlight(1/phaseRate);
const summerBirds=makeSummerBirds(summerFlight.count);
resize(); ready=true; render(); loading.hidden=true;
syncPause(); updateUi(true);
new ResizeObserver(resize).observe(stage);

function tick(now) {
  const dt=previousTime?Math.min((now-previousTime)/1000,MAX_FRAME_SECONDS):0;
  previousTime=now;
  if(!paused&&!document.hidden) {
    updatePlaybackMode();
    time+=dt*speed;
    phase=((needlePhaseOffset+time*phaseRate)%4+4)%4;
    render();
    if(now-lastUiUpdate>120) { updateUi(); lastUiUpdate=now; }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
play.addEventListener('click',()=>{paused=!paused;syncPause();status.textContent=paused?'动画已暂停':'动画继续播放';});
timeline.addEventListener('input',()=>setPhase(Number(timeline.value)/1000));
seasonButtons.forEach((button,i)=>button.addEventListener('click',()=>{
  setPhase(i+.86); status.textContent=`已切换至${seasonNames[i]}`;
}));
document.querySelector('#speed').addEventListener('change',event=>{
  requestedSpeed=Number(event.target.value);
  updatePlaybackMode();
  render();
});
canvas.tabIndex=0;
canvas.addEventListener('keydown',event=>{
  if(event.code==='Space') { event.preventDefault(); paused=!paused; syncPause(); }
});
motionPreference.addEventListener('change',event=>{if(event.matches) {paused=true;syncPause();}});
document.addEventListener('visibilitychange',()=>{previousTime=0;});
document.querySelector('.fullscreen').addEventListener('click',async()=>{
  try {
    if(document.fullscreenElement)await document.exitFullscreen();
    else if(stage.requestFullscreen)await stage.requestFullscreen();
    else status.textContent='此浏览器不支持全屏观看。';
  }catch {status.textContent='当前窗口无法进入全屏，可以在浏览器中打开观看。';}
});
document.querySelector('#save').addEventListener('click',()=>{
  render();
  canvas.toBlob(blob=>{
    if(!blob) {status.textContent='画面保存失败，请重试。';return;}
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=`四季轮转-${seasonNames[Math.floor(phase)]}.png`;a.click();
    setTimeout(()=>URL.revokeObjectURL(url),10000);status.textContent='已保存当前画面。';
  },'image/png');
});
canvas.addEventListener('webglcontextlost',event=>{
  event.preventDefault();paused=true;syncPause();loading.hidden=false;loading.textContent='3D 画面已中断，请刷新页面恢复。';
});

// A small inspection API for deterministic visual checks and future tuning.
window.seasons={
  setPhase,
  setTime(value){
    time=Math.max(0,Number(value)||0);
    catTimeOffset=0;timelapse=null;firstFoxtailPlan=-Infinity;
    lastTrampleTime=null;resetFoxtailPlans();updatePlaybackMode();render();
  },
  setPaused(value){paused=Boolean(value);syncPause();},
  setTrampling(value){uniforms.uTrampleStrength.value=value?1:0;render();},
  getFootContacts(){return pawContacts.map(contact=>({...contact,compression:trampleField.sample(contact.x,contact.z)}));},
  getTrampleAt(x,z){return trampleField.sample(x,z);},
  getState(){return {phase,time,paused,speed,season:Math.floor(phase),blades:SETTINGS.blades,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles};},
};
canvas.dataset.ready='true';
