import * as THREE from './vendor/three.module.js';

// Four revolutions make a year. The geometry stays still; the seasons pass over it.
const SETTINGS = {
  radius: 5.4,
  hubRadius: .96,
  blades: matchMedia('(max-width: 700px)').matches ? 84000 : 196000,
  flowers: 12500,
  particles: 2200,
  snowflakes: matchMedia('(max-width: 700px)').matches ? 1400 : 3200,
  grassHeight: 1.5,
  grassRecoverySeconds: 1.2,
  snowPrintSeconds: 14,
  yearSeconds: 112,
  initialPhase: .87,
  seed: 713821,
};
const TAU = Math.PI * 2;
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
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(27.5, 16 / 9, .1, 110);
camera.position.set(0, 9.5, 14.8);
camera.lookAt(0, .10, 0);

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

// Grass and flowers sample the same drifting gusts. Individual blades retain a little tip flutter.
const windGLSL = `
  uniform float uGrassHeight;
  uniform sampler2D uWindMap;
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

const snowGLSL = `
  float snowNoise(vec2 p) {
    vec2 cell=floor(p), f=fract(p);
    f=f*f*(3.-2.*f);
    return mix(mix(hash(cell),hash(cell+vec2(1.,0.)),f.x),
               mix(hash(cell+vec2(0.,1.)),hash(cell+vec2(1.,1.)),f.x),f.y);
  }
  float snowHeight(vec2 p) {
    float radius=length(p);
    float edge=smoothstep(.99,1.18,radius)*(1.-smoothstep(5.16,5.35,radius));
    float drift=.072 + .046*snowNoise(p*1.65) + .023*snowNoise(p*4.2);
    drift+=.022*pow(.5+.5*sin(p.x*.9+p.y*1.7),2.);
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
      const g = c.createRadialGradient(x, y, 0, x, y, size * 5);
      g.addColorStop(0, 'rgba(185,208,236,.13)'); g.addColorStop(1, 'rgba(185,208,236,0)');
      c.fillStyle = g; c.fillRect(x-size*5, y-size*5, size*10, size*10);
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
      void main() {
        vec4 s = seasons(vPosition,uPhase);
        float r = length(vPosition);
        vec3 color = mat4x3(vec3(.086,.14,.043),vec3(.068,.129,.028),vec3(.274,.186,.072),vec3(.024,.032,.034)) * s;
        float grooves = .74 + .26 * smoothstep(-.8,.8,sin(r*173.));
        color *= mix(.85,grooves,s.w) * (.78 + .22*hash(floor(vPosition*165.)));
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
    uniforms, side:THREE.DoubleSide,
    vertexShader:`
      uniform float uPhase;
      varying vec3 vWorld; varying vec3 vNormal;
      ${seasonGLSL}
      ${snowGLSL}
      ${trampleGLSL}
      void main() {
        vec2 p=position.xz;
        float cover=seasons(p,uPhase).w;
        float amount=smoothstep(.02,.98,cover);
        float surface=snowHeight(p)-.034*snowPrintAt(p);
        vec3 world=vec3(p.x,mix(-.018,surface,amount),p.y);
        float dx=(snowHeight(p+vec2(.035,0.))-snowHeight(p-vec2(.035,0.)))/.07;
        float dz=(snowHeight(p+vec2(0.,.035))-snowHeight(p-vec2(0.,.035)))/.07;
        vNormal=normalize(vec3(-dx,1.,-dz)); vWorld=world;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(world,1.);
      }`,
    fragmentShader:`
      uniform float uPhase;
      varying vec3 vWorld; varying vec3 vNormal;
      ${seasonGLSL}
      ${snowGLSL}
      ${catShadowGLSL}
      ${trampleGLSL}
      void main() {
        // Re-evaluate the angular edge per pixel; interpolating the mask across
        // the ring would leave visible triangles along the seasonal boundary.
        float cover=seasons(vWorld.xz,uPhase).w;
        if(cover<.11)discard;
        vec2 p=vWorld.xz;
        // The thinning blanket breaks into small patches, exposing the grass beneath.
        if(cover<.85) {
          float snowThreshold=.11+.58*snowNoise(p*4.1)+.16*hash(floor(p*80.));
          if(cover<snowThreshold)discard;
        }
        float print=snowPrintAt(p);
        vec2 stepSize=vec2(.033,0.);
        float printDx=snowPrintAt(p+stepSize)-snowPrintAt(p-stepSize);
        float printDz=snowPrintAt(p+stepSize.yx)-snowPrintAt(p-stepSize.yx);
        vec3 normal=normalize(vNormal+vec3(printDx,0.,printDz)*.68);
        float light=clamp(dot(normal,normalize(vec3(-.5,1.,.45))),0.,1.);
        float drift=snowNoise(p*1.65);
        vec3 color=mix(vec3(.69,.77,.83),vec3(.96,.98,.98),light*.78+drift*.15);
        color*=mix(vec3(1.),vec3(.58,.68,.76),smoothstep(.04,.85,print));
        float grain=hash(floor(vWorld.xz*320.));
        color+=(grain-.5)*.022+pow(grain,40.)*.07;
        float radius=length(vWorld.xz);
        color*=.87+.13*smoothstep(1.0,1.3,radius);
        color*=catShade(vWorld.xz,vec2(.9,1.5),9.,.20);
        color*=mix(.90,1.,smoothstep(.18,.80,cover));
        gl_FragColor=vec4(color,1.);
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
      uniform float uTime; uniform float uPhase; uniform vec2 uNeedleDirection;
      attribute vec4 aRoot; attribute vec4 aTraits;
      varying float vHeight; varying vec2 vShade; varying float vNoise; varying float vPressure; varying vec4 vSeason;
      varying float vAcross;
      ${seasonGLSL}
      ${windGLSL}
      ${trampleGLSL}
      ${catShadowGLSL}
      void main() {
        vec2 root=aRoot.xy;
        float coverage=seasonCoverageAt(root,fract(uPhase),aRoot.z,aRoot.w);
        vec4 s=seasonWeights(coverage,uPhase);
        float t = position.y;
        float h = aTraits.x * meadowHeight(root,s);
        h *= 1. - s.w * (1.-(.43+.57*pow(aTraits.w,14.)));
        vec2 sideways = normalize(aTraits.yz);
        vec3 wind=meadowWind(root,uTime);
        vec2 flow=wind.xy+vec2(-root.y,root.x)*.018*s.z;
        float flowLength=length(flow);
        vec2 direction=flow/max(flowLength,.001);
        float bendAngle=clamp((.14+flowLength*1.24)*(.83+aTraits.w*.33),.08,1.45);
        bendAngle*=1.-s.w*.83;
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
        vHeight=t; vNoise=aTraits.w; vPressure=pressure; vAcross=sign(position.x);
        vShade.x=(.82+.14*abs(dot(bladeNormal,normalize(vec3(-.5,.85,.4)))))*(.92+.13*wind.z)*shadow*(1.-pressure*.16);
        float along=dot(root,uNeedleDirection);
        float crossDistance=root.x*uNeedleDirection.y-root.y*uNeedleDirection.x;
        vShade.y=1.-.15*exp(-crossDistance*crossDistance*100.)*step(.9,along)*step(along,5.);
        gl_Position = projectionMatrix*modelViewMatrix*vec4(world,1.);
      }`,
    fragmentShader: `
      varying float vHeight; varying vec2 vShade; varying float vNoise; varying float vPressure; varying vec4 vSeason;
      varying float vAcross;
      void main() {
        vec3 root = mat4x3(vec3(.075,.148,.049),vec3(.077,.151,.058),vec3(.40,.274,.117),vec3(.55,.63,.66))*vSeason;
        vec3 tip = mat4x3(vec3(.44,.60,.305),vec3(.425,.59,.232),vec3(1.,.785,.452),vec3(.88,.93,.94))*vSeason;
        vec3 color = mix(root,tip,.16+.79*pow(vHeight,.62));
        color *= (.93+vNoise*.12) * vShade.x * .80;
        color += tip*.045*smoothstep(.52,.99,vHeight)*(1.-vPressure*.60);
        color*=vShade.y;
        color*=1.-vPressure*.30*(1.-vHeight*.25);
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
        float bendAngle=clamp(.14+length(wind.xy)*1.24,.08,1.45);
        float h=p.y*meadowHeight(position.xz,s);
        vec3 trample=trampleAt(position.xz);
        float pressure=clamp(trample.x*1.12,0.,.96);
        vec2 direction=normalize(wind.xy);
        vec2 bend=direction*h*(1.-cos(bendAngle))/bendAngle;
        vec2 laid=trample.yz*.60+direction*h*.16*pressure;
        p.xz+=mix(bend,laid,pressure);
        p.y=h*sin(bendAngle)/bendAngle*(1.-pressure*.87)+.008;
        vec4 view=modelViewMatrix*vec4(p,1.);
        vAlpha=(s.x*.84+s.y*.06)*(.4+.6*aTraits.x);
        vColor=mix(vec3(.86,.89,.78),vec3(.82,.89,.9),s.w);
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
  const stem = new THREE.Mesh(new THREE.TubeGeometry(curve,64,.012,5,false),new THREE.MeshStandardMaterial({color:'#d2c080',roughness:.6,metalness:.2,emissive:'#7c6a2b',emissiveIntensity:.18}));
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
const torsoProfile=new THREE.SplineCurve([
  [0,-.368],[.086,-.341],[.137,-.275],[.148,-.185],[.120,-.052],
  [.129,.085],[.143,.178],[.124,.249],[.080,.296],[0,.323],
].map(([radius,x])=>new THREE.Vector2(radius,x)));
const torsoGeometry=new THREE.LatheGeometry(torsoProfile.getPoints(32),24);
torsoGeometry.rotateZ(-Math.PI/2);
torsoGeometry.scale(1,1,.89);
const torsoVertices=torsoGeometry.getAttribute('position');
for(let i=0;i<torsoVertices.count;i++) {
  const x=torsoVertices.getX(i);
  torsoVertices.setY(i,torsoVertices.getY(i)+.044*THREE.MathUtils.smoothstep(x,-.22,.26));
}
torsoGeometry.computeVertexNormals();

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

function makeCat(white) {
  const root=new THREE.Group(); root.scale.setScalar(.72); scene.add(root);
  const bodyPivot=new THREE.Group(); bodyPivot.position.y=.334; root.add(bodyPivot);
  const bodyGroup=new THREE.Group(); bodyGroup.position.y=-bodyPivot.position.y; bodyPivot.add(bodyGroup);
  const fur=new THREE.MeshStandardMaterial({color:white?'#e4e2cb':'#0c1119',roughness:.91,metalness:0});
  const inner=new THREE.MeshStandardMaterial({color:white?'#bd9e94':'#46404b',roughness:1});
  const muzzle=new THREE.MeshStandardMaterial({color:white?'#ece7d7':'#161d27',roughness:.94});
  const eyeMat=new THREE.MeshStandardMaterial({color:white?'#7b8050':'#b6bd81',emissive:'#5d6345',emissiveIntensity:.16,roughness:.45});
  const pupilMat=new THREE.MeshStandardMaterial({color:'#090c10',roughness:.55});
  const body=new THREE.Mesh(torsoGeometry,fur);
  body.position.y=.334; bodyGroup.add(body);
  const neck=ellipsoid(bodyGroup,fur,[.225,.411,0],[.132,.108,.103]);
  neck.rotation.z=.59;
  const head=new THREE.Group(); head.position.set(.295,.48,0); bodyGroup.add(head);
  ellipsoid(head,fur,[0,0,0],[.134,.118,.112]);
  ellipsoid(head,muzzle,[.093,-.061,0],[.057,.038,.063]);
  const noseMaterial=new THREE.MeshStandardMaterial({color:white?'#9f7c74':'#202431',roughness:.8});
  ellipsoid(head,noseMaterial,[.156,-.025,0],[.014,.012,.020]);
  const ears=[];
  for(const side of [-1,1]) {
    const ear=new THREE.Group();
    ear.position.set(-.026,.075,side*.073); head.add(ear);
    const shell=new THREE.Mesh(new THREE.ConeGeometry(.065,.152,3),fur);
    shell.position.y=.056; shell.rotation.z=.12; ear.add(shell);
    const inset=new THREE.Mesh(new THREE.ConeGeometry(.037,.100,3),inner);
    inset.position.set(.023,.054,0); inset.rotation.z=-.13; ear.add(inset);
    ears.push({joint:ear,side});
    ellipsoid(head,muzzle,[.105,-.038,side*.033],[.053,.041,.049]);
    ellipsoid(head,eyeMat,[.098,.021,side*.078],[.015,.014,.009]);
    ellipsoid(head,pupilMat,[.107,.022,side*.084],[.007,.010,.006]);
  }
  const legs=[];
  for(const x of [-.205,.18])for(const side of [-1,1]) {
    const pivot=new THREE.Group(); pivot.position.set(x,.34,side*.084); bodyGroup.add(pivot);
    const front=x>0;
    if(front)ellipsoid(pivot,fur,[0,-.10,0],[.038,.125,.036]);
    else ellipsoid(pivot,fur,[-.012,-.065,0],[.061,.138,.051]);
    const ankle=new THREE.Group(); ankle.position.y=-.19; pivot.add(ankle);
    ellipsoid(ankle,fur,[.018,-.048,0],[.029,.071,.029]);
    const paw=ellipsoid(ankle,fur,[.049,-.102,0],[.050,.026,.037]);
    legs.push({pivot,ankle,paw,front,side,sole:new THREE.Vector3(),snowContact:false});
  }
  const tailBones=makeCatTail(bodyGroup,fur);
  const whiskers=[];
  for(const side of [-1,1])for(let k=0;k<3;k++) {
    whiskers.push(.12,-.04,side*.065,.22-k*.025,-.035-k*.012,side*(.15+k*.01));
  }
  const whiskerGeometry=new THREE.BufferGeometry();
  whiskerGeometry.setAttribute('position',new THREE.Float32BufferAttribute(whiskers,3));
  head.add(new THREE.LineSegments(whiskerGeometry,new THREE.LineBasicMaterial({color:white?'#c9c8b6':'#71808d',transparent:true,opacity:.45})));
  const cat={root,bodyPivot,body,head,ears,tailBones,legs};
  cat.takeoffSupport=hopSupportAt(cat,CAT_HOP.launch);
  cat.landingSupport=hopSupportAt(cat,CAT_HOP.land);
  return cat;
}

const CAT_HOP = {
  crouch:.105, launch:.24, climbEnd:.325,
  levelStart:.45, levelEnd:.52,
  land:.685, absorb:.77, hindDown:.875,
};
const CAT_CYCLE_SECONDS=4.4;
const catLandings = Array.from({length:8},(_,i)=>{
  const angle=i*TAU/8-Math.PI*.75;
  return {x:Math.cos(angle)*1.72,z:2.99+Math.sin(angle)*.70};
});

// A beat either holds its position or travels to a fraction of the next waypoint.
const catRoutines=[
  [
    {kind:'peek',seconds:.56},
    {kind:'jump',seconds:1.80,to:1},
    {kind:'scan',seconds:.62},
  ],
  [
    {kind:'walk',seconds:.74,to:.43},
    {kind:'sniff',seconds:.86},
    {kind:'walk',seconds:.90,to:1},
    {kind:'peek',seconds:.54},
  ],
  [
    {kind:'stalk',seconds:.85,to:.32},
    {kind:'pounce',seconds:1.54,to:1},
    {kind:'sniff',seconds:.73},
  ],
  [
    {kind:'scan',seconds:.64},
    {kind:'pounce',seconds:1.50,to:.59},
    {kind:'peek',seconds:.52},
    {kind:'walk',seconds:.83,to:1},
  ],
].map(beats=>{
  let seconds=0,position=0,moveEnd=0;
  const segments=beats.map(({kind,seconds:duration,to=position})=>{
    const beat={kind,start:seconds,end:seconds+duration,from:position,to};
    seconds=beat.end;
    if(to>position)moveEnd=seconds;
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
  {at:.475,front:[.93,-1.42],hind:[-.72,1.37],stretch:1.10,tail:-.03},
  {at:.60,front:[1.03,-.68],hind:[-.66,1.33],stretch:1.11,tail:.12},
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

function poseHopLeg(leg,pose,air,pouncing) {
  const joint=leg.front?0:2;
  const reach=leg.front?.13:.095;
  leg.pivot.rotation.z=pose[joint]+leg.side*reach*air+(pouncing?(leg.front?.18:-.08)*air:0);
  leg.ankle.rotation.z=pose[joint+1]-leg.side*.11*air;
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
  const covered=THREE.MathUtils.smoothstep(distance+feather*contour,-feather,feather);
  return current===3?covered:1-covered;
}

const walkUpperLeg=.19;
const walkLowerLeg=Math.hypot(.049,.102);
const walkPawAngle=Math.atan2(.049,.102);

function poseWalkingLeg(leg,step,stride,weight,crouch) {
  const {clamp,lerp,smoothstep}=THREE.MathUtils;
  const stepPhase=fract(step+(leg.front?0:.24)+(leg.side===1?.5:0));
  const stance=.62;
  const swing=clamp((stepPhase-stance)/(1-stance),0,1);
  // During stance the local paw target offsets the body's forward travel.
  const offset=stepPhase<stance?stance*.5-stepPhase:stance*(smoothstep(swing,0,1)-.5);
  const x=.017+stride*offset;
  const down=.272-.044*crouch-.088*Math.sin(Math.PI*swing);
  const kneeCos=(x*x+down*down-walkUpperLeg**2-walkLowerLeg**2)/(2*walkUpperLeg*walkLowerLeg);
  const knee=(leg.front?-1:1)*Math.acos(clamp(kneeCos,-1,1));
  const hip=Math.atan2(x,down)-Math.atan2(walkLowerLeg*Math.sin(knee),walkUpperLeg+walkLowerLeg*Math.cos(knee));
  const idle=leg.front?catIdlePose.front:catIdlePose.hind;
  leg.pivot.rotation.z=lerp(idle[0],hip,weight);
  leg.ankle.rotation.z=lerp(idle[1],knee-walkPawAngle,weight);
}

function animateCat(cat,index,atTime) {
  const {lerp,clamp,smoothstep}=THREE.MathUtils;
  const cycle=Math.floor(atTime/CAT_CYCLE_SECONDS);
  const point=(cycle+index*2)%catLandings.length;
  const localTime=atTime-cycle*CAT_CYCLE_SECONDS;
  const routine=catRoutineAt(cycle,index);
  const wait=(CAT_CYCLE_SECONDS-routine.seconds)*(.22+index*.34+.30*catNoise(cycle,index));
  const elapsed=localTime-wait;
  const beat=routine.segments.find(segment=>elapsed<segment.end)??routine.segments.at(-1);
  const progress=clamp((elapsed-beat.start)/(beat.end-beat.start),0,1);
  const stalking=beat.kind==='stalk';
  const walking=beat.kind==='walk'||stalking;
  const pouncing=beat.kind==='pounce';
  const hopping=beat.kind==='jump'||pouncing;
  const flight=hopping?clamp((progress-CAT_HOP.launch)/(CAT_HOP.land-CAT_HOP.launch),0,1):0;
  const advance=walking?smoothstep(progress,.16,.87):flight;
  const travel=lerp(beat.from,beat.to,advance);
  const from=catLandings[point];
  const to=catLandings[(point+1)%catLandings.length];
  const next=catLandings[(point+2)%catLandings.length];
  const x=lerp(from.x,to.x,travel), z=lerp(from.z,to.z,travel);
  const dx=to.x-from.x, dz=to.z-from.z;
  const distance=Math.hypot(dx,dz)*(beat.to-beat.from);
  const hopHeight=(pouncing?.39:.67)+.09*distance;
  cat.flight=flight;
  cat.airHeight=4*hopHeight*flight*(1-flight);
  const heading=-Math.atan2(dz,dx);
  const nextHeading=-Math.atan2(next.z-to.z,next.x-to.x);
  const turn=Math.atan2(Math.sin(nextHeading-heading),Math.cos(nextHeading-heading));
  cat.root.rotation.y=heading+turn*smoothstep(localTime,wait+routine.moveEnd,CAT_CYCLE_SECONDS-.035);
  cat.root.position.set(x,0,z);

  const gesture=Math.sin(Math.PI*progress)**2;
  const peek=beat.kind==='peek'?gesture:0;
  const sniff=beat.kind==='sniff'?gesture:0;
  const scan=beat.kind==='scan'?gesture:0;

  const air=Math.sin(Math.PI*flight);
  const landing=hopping?smoothstep(progress,CAT_HOP.land,CAT_HOP.absorb)*(1-smoothstep(progress,.825,.95)):0;
  const walkWeight=smoothstep(progress,.035,.16)*(1-smoothstep(progress,.87,.99));
  const crouch=stalking?walkWeight:0;
  const strides=Math.max(2,Math.ceil(distance/.33));
  const step=advance*strides;
  const stride=distance/(strides*cat.root.scale.x);
  const strideWave=Math.sin(TAU*step);
  const hopPose=catHopSpline.evaluate(hopping?progress:0);
  const pitch=(walking?(-.055+.026*strideWave)*walkWeight:catHopPitch(hopping?progress:0))+.10*peek-.13*sniff-.07*crouch;
  cat.bodyPivot.rotation.z=pitch;
  cat.bodyPivot.rotation.x=walking?.046*walkWeight*strideWave:.035*air*Math.sin(TAU*flight+index);
  const breath=.013*Math.sin(atTime*3.3+index*1.65);
  cat.body.scale.set(walking?1+.025*walkWeight*strideWave:hopPose[4],1+breath-.05*sniff-.065*landing,1+breath);
  const gaze=scan*.68*Math.sin(TAU*progress+index*1.5)+(hopping&&beat.to===1?turn*.31*smoothstep(progress,.47,.70)*(1-smoothstep(progress,.79,1)):0);
  cat.head.position.set(.295+.049*sniff,.48+.065*peek+.035*scan-.084*sniff,0);
  cat.head.rotation.set(.07*scan*Math.sin(TAU*progress),gaze,-pitch*.32-.49*sniff+.15*peek+.04*sniff*Math.sin(atTime*17));
  for(const {joint,side} of cat.ears) {
    const flick=Math.max(0,Math.sin(atTime*3.8+side*1.7+index))**10;
    joint.rotation.set(side*(.15+.12*flick),side*.16+.40*gaze,.04+.12*peek-.10*sniff);
  }
  cat.tailBones.forEach((bone,joint)=>{
    const wave=atTime*2.9+index*1.7-joint*.62;
    bone.rotation.y=Math.sin(wave)*(.09+.036*joint)*(1+.50*scan)+.05*turn*air;
    bone.rotation.z=(joint===0?(walking?.05*walkWeight:hopPose[5]):.032*Math.sin(wave))-.055*peek+.05*sniff;
  });
  for(const leg of cat.legs) {
    if(walking)poseWalkingLeg(leg,step,stride,walkWeight,crouch);
    else poseHopLeg(leg,hopPose,air,pouncing);
    if(leg.front) {
      leg.pivot.rotation.z+=.22*sniff;
      leg.ankle.rotation.z-=.36*sniff;
    }
  }

  cat.snowLift=snowCoverAt(x,z)*.065;
  cat.contactWeight=.38+.24*landing;
}

let lastTrampleTime=null;
let pawContacts=[];
function poseAndStampCats(atTime) {
  const contacts=[];
  cats.forEach((cat,index)=>{
    animateCat(cat,index,atTime);
    const airborne=cat.flight>0&&cat.flight<1;
    let support=measurePawSupport(cat);
    if(airborne) {
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
      const force=airborne?0:cat.contactWeight*(1-THREE.MathUtils.smoothstep(height,.018,.075));
      contacts.push({cat:index,paw:pawIndex,x,z,height,force});
      const snow=snowCoverAt(x,z);
      const snowContact=!airborne&&snow>.55&&height<.043;
      if(snowContact&&!leg.snowContact)trampleField.stamp(x,z,headingX,headingZ,.105,.074,.95,true);
      leg.snowContact=snowContact;
      trampleField.stamp(x,z,headingX,headingZ,.115,.090,force*(1-snow));
    });
  });
  pawContacts=contacts;
}
function updateTrampling(atTime) {
  const dt=lastTrampleTime===null?Infinity:atTime-lastTrampleTime;
  if(dt<0||dt>.18) {
    trampleField.clear();
    for(const cat of cats)for(const leg of cat.legs)leg.snowContact=false;
    // Rebuild only the recent steps when seeking, without rendering the replay.
    const winter=Math.floor(phase)===3||Math.floor(phase)===0;
    const start=Math.max(0,atTime-(winter?24:4.8)),step=1/30;
    for(let t=start;t<atTime;t+=step) {
      trampleField.decay(step);poseAndStampCats(t);
    }
  } else {
    trampleField.decay(dt);
  }
  poseAndStampCats(atTime);
  trampleField.upload();lastTrampleTime=atTime;
}

function makeParticles() {
  const geometry=new THREE.BufferGeometry();
  const seeds=new Float32Array(SETTINGS.particles*4);
  for(let i=0;i<SETTINGS.particles;i++)seeds.set([random(),random(),random(),random()],i*4);
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(SETTINGS.particles*3),3));
  geometry.setAttribute('aSeed',new THREE.BufferAttribute(seeds,4));
  const material=new THREE.ShaderMaterial({
    uniforms,transparent:true,depthWrite:false,
    vertexShader:`
      uniform float uTime; uniform float uPhase; uniform float uPointScale;
      attribute vec4 aSeed; varying float vAlpha; varying vec3 vColor; varying float vSpin;
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
        float enabled=dot(s,vec4(.12,.04,.95,0.));
        vAlpha=sin(age*3.14159)*enabled*(.5+aSeed.w*.5)*smoothstep(.8,1.2,r);
        vColor=mat4x3(vec3(.9,.89,.72),vec3(.75,.78,.47),vec3(.94,.73,.34),vec3(.76,.85,.91))*s;
        vSpin=aSeed.z*TAU+uTime*(.3+aSeed.w);
        vec4 view=modelViewMatrix*vec4(p,1.);
        gl_Position=projectionMatrix*view;
        gl_PointSize=(1.15+aSeed.w*3.8)*uPointScale*16./-view.z;
      }`,
    fragmentShader:`
      varying float vAlpha; varying vec3 vColor; varying float vSpin;
      void main() {
        vec2 p=gl_PointCoord-.5;
        p=mat2(cos(vSpin),-sin(vSpin),sin(vSpin),cos(vSpin))*p;
        float d=length(p*vec2(1.,2.2));
        float a=(1.-smoothstep(.22,.5,d))*vAlpha;
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
      void main() {
        float age=fract(aSeed.z+uTime*(.065+aSeed.w*.055));
        float angle=aSeed.x*TAU, radius=sqrt(aSeed.y)*5.7;
        vec2 root=vec2(cos(angle),sin(angle))*radius;
        vec3 p=vec3(root.x,.12+(1.-age)*3.5,root.y);
        p.x+=sin(uTime*.55+aSeed.z*TAU)*(.06+aSeed.w*.12)+age*.16;
        p.z+=sin(uTime*.38+aSeed.w*TAU)*.10;
        float winter=seasons(p.xz,uPhase).w;
        float bounds=1.-smoothstep(5.25,5.7,length(p.xz));
        float fade=smoothstep(0.,.09,age)*(1.-smoothstep(.90,1.,age));
        vAlpha=winter*bounds*fade*(.48+aSeed.w*.42);
        vSoftness=aSeed.w;
        vec4 view=modelViewMatrix*vec4(p,1.);
        gl_Position=projectionMatrix*view;
        gl_PointSize=(1.2+pow(aSeed.w,2.)*3.4)*uPointScale*17./-view.z;
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
  foxtail.head.rotation.y=Math.sin(time*1.4)*.025;
  updateTrampling(time);
  uniforms.uCats.value.set(cats[0].root.position.x,cats[0].root.position.z,cats[1].root.position.x,cats[1].root.position.z);
  uniforms.uCatAir.value.set(cats[0].airHeight,cats[1].airHeight);
  snowCover.visible=snowfall.visible=phase<1||phase>3;
  flowers.visible=phase>0&&phase<3;
  renderer.render(scene,camera);
}
const fract=x=>x-Math.floor(x);

setupLights(); makeSky(); makeDisc(); makeGrass();
const flowers=makeFlowers();
const snowCover=makeSnowCover();
const foxtail=makeFoxtail();
const cats=[makeCat(false),makeCat(true)];
makeParticles();
const snowfall=makeSnowfall();
resize(); ready=true; render(); loading.hidden=true;
syncPause(); updateUi(true);
new ResizeObserver(resize).observe(stage);

function tick(now) {
  const dt=previousTime?Math.min((now-previousTime)/1000,.065):0;
  previousTime=now;
  if(!paused&&!document.hidden) {
    time+=dt*speed;
    phase=(phase+dt*speed*4/SETTINGS.yearSeconds)%4;
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
document.querySelector('#speed').addEventListener('change',event=>{speed=Number(event.target.value);});
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
  setTime(value){time=Math.max(0,Number(value)||0);render();},
  setPaused(value){paused=Boolean(value);syncPause();},
  setTrampling(value){uniforms.uTrampleStrength.value=value?1:0;render();},
  getFootContacts(){return pawContacts.map(contact=>({...contact,compression:trampleField.sample(contact.x,contact.z)}));},
  getTrampleAt(x,z){return trampleField.sample(x,z);},
  getState(){return {phase,time,paused,speed,season:Math.floor(phase),blades:SETTINGS.blades,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles};},
};
canvas.dataset.ready='true';
