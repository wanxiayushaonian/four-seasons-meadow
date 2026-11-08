import * as THREE from './vendor/three.module.js';

// Each point is [season phase, x, height, z]. The flock enters from the right.
const route=[
  [1.045,6.55,1.19,.92],
  [1.145,3.48,1.23,1.52],
  [1.30,1.55,1.35,2.79],
  [1.46,-1.20,1.24,3.05],
  [1.61,-3.21,1.38,1.26],
  [1.77,-2.88,1.22,-1.48],
  [1.92,-1.75,1.34,-2.33],
  [2.055,.83,1.37,-2.90],
  [2.145,2.58,1.48,-3.58],
  [2.245,4.85,1.69,-4.40],
];
const startingOffsets=[
  [-.27,.045,.11],[.18,-.02,-.39],[.52,.12,.30],
  [-.03,-.09,.60],[.70,.14,-.10],[.29,.02,-.66],
];

export function buildSummerFlight(seasonSeconds) {
  const start=route[0][0],end=route.at(-1)[0];
  const duration=(end-start)*seasonSeconds;
  const frames=Math.ceil(duration*36)+1;
  const step=duration/(frames-1);
  const guide=new THREE.CubicInterpolant(
    Float32Array.from(route,point=>point[0]),
    Float32Array.from(route.flatMap(point=>point.slice(1))),
    3,
  );
  const lookAhead=.20;
  const goal=new THREE.Vector3(), goalVelocity=new THREE.Vector3();
  const flockCenter=new THREE.Vector3(), flockVelocity=new THREE.Vector3();
  const guideForce=new THREE.Vector3();
  const initial=new THREE.Vector3().fromArray(guide.evaluate(start));
  const boids=startingOffsets.map((offset,i)=>({
    position:new THREE.Vector3().fromArray(offset).add(initial),
    velocity:new THREE.Vector3(-1.13+i*.022,(i%2-.5)*.035,.22-i*.019),
    acceleration:new THREE.Vector3(),
  }));
  const width=boids.length*3;
  const samples=new Float32Array(frames*width);
  const relative=new THREE.Vector3(), center=new THREE.Vector3(), velocity=new THREE.Vector3();
  for(let frame=0;frame<frames;frame++) {
    const elapsed=frame*step;
    const phase=start+elapsed/seasonSeconds;
    goal.fromArray(guide.evaluate(phase));
    goalVelocity.fromArray(guide.evaluate(phase+lookAhead/seasonSeconds)).sub(goal).divideScalar(lookAhead);
    flockCenter.set(0,0,0);flockVelocity.set(0,0,0);
    for(const bird of boids) {
      flockCenter.add(bird.position);
      flockVelocity.add(bird.velocity);
    }
    flockCenter.divideScalar(boids.length);
    flockVelocity.divideScalar(boids.length);
    guideForce.copy(goal).sub(flockCenter).multiplyScalar(1.12);
    guideForce.addScaledVector(goalVelocity.sub(flockVelocity),1.56);
    for(const [i,bird] of boids.entries()) {
      bird.position.toArray(samples,frame*width+i*3);
      const force=bird.acceleration.copy(guideForce);
      let neighbors=0;
      center.set(0,0,0);velocity.set(0,0,0);
      for(const other of boids) {
        if(other===bird)continue;
        relative.copy(bird.position).sub(other.position);
        const distance=relative.length();
        if(distance<.67&&distance>.0001)force.addScaledVector(relative,4.4*(1-distance/.67)/distance);
        if(distance<1.65) {
          center.add(other.position);
          velocity.add(other.velocity);
          neighbors++;
        }
      }
      if(neighbors) {
        force.addScaledVector(velocity.divideScalar(neighbors).sub(bird.velocity),.94);
        force.addScaledVector(center.divideScalar(neighbors).sub(bird.position),.41);
      }
      // Small individual changes in pace keep the group loose while it turns.
      force.x+=.18*Math.sin(elapsed*1.39+i*2.15);
      const altitude=goal.y+startingOffsets[i][1]*.5;
      force.y+=.15*Math.sin(elapsed*2.07+i*1.76)+(altitude-bird.position.y)*.96;
      force.z+=.21*Math.sin(elapsed*1.63+i*2.84);
    }
    // Update together so every bird reacts to the same previous positions.
    for(const bird of boids) {
      bird.velocity.addScaledVector(bird.acceleration,step).clampLength(0,1.86);
      bird.position.addScaledVector(bird.velocity,step);
    }
  }
  return {
    start,end,count:boids.length,
    sample(phase,target) {
      const frame=THREE.MathUtils.clamp((phase-start)/(end-start),0,1)*(frames-1);
      const i=Math.min(Math.floor(frame),frames-2);
      const offset=i*width;
      const blend=frame-i;
      for(let n=0;n<width;n++)target[n]=THREE.MathUtils.lerp(samples[offset+n],samples[offset+width+n],blend);
    },
  };
}
