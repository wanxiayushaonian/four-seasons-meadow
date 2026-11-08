const sitSeconds=.72;
const standSeconds=.67;
const restSeconds=2.15;
const clearance=.30;
export const foxtailJumpHeight=.80;
export const foxtailJumpWindow={before:3.5,after:20};
const jumpTimings=[[1.52,.36],[1.26,.36],[1.03,.24],[1.88,.36],[2.12,.36],[1.52,.82],[1.52,1.18],[1.52,1.56]];

function progressAt(time,start,end) {
  return Math.min(1,Math.max(0,(time-start)/(end-start)));
}

function ease(value) { return value*value*(3-2*value); }
function mix(a,b,t) { return a+(b-a)*t; }

function turn(from,to,weight) {
  const delta=to-from;
  return from+Math.atan2(Math.sin(delta),Math.cos(delta))*weight;
}

function across(point,angle) {
  return point.z*Math.cos(angle)-point.x*Math.sin(angle);
}

function between(a,b,t) { return {x:mix(a.x,b.x,t),z:mix(a.z,b.z,t)}; }

function blendPose(motion,weight,heading) {
  const hopping=motion.kind==='jump'||motion.kind==='pounce';
  const progress=hopping?mix(motion.flight===0?0:1,motion.progress,weight):motion.progress;
  return {...motion,progress,heading,poseWeight:weight,sitting:motion.sitting*weight};
}

function travelProgress(kind,progress,hop) {
  return kind==='walk'||kind==='stalk'?ease(progressAt(progress,.12,.90)):progressAt(progress,hop.launch,hop.land);
}

function safeRecovery(to,move,land,angleAt,side,hop) {
  const steps=Math.ceil((move.end-land)/.15);
  for(let i=0;i<=steps;i++) {
    const t=mix(land,move.end,i/steps);
    const progress=travelProgress(move.kind,progressAt(t,move.start,move.end),hop);
    const point=between(to,move.target,progress);
    const angle=angleAt(t);
    const along=point.x*Math.cos(angle)+point.z*Math.sin(angle);
    if(along>1.02&&side*across(point,angle)>-.25)return false;
  }
  return true;
}

function recoveryMove(to,scheduled,sample,land,limit,angleAt,side,hop) {
  const {start}=scheduled;
  const distance=Math.hypot(scheduled.target.x-to.x,scheduled.target.z-to.z);
  const speedLimit=scheduled.kind==='walk'||scheduled.kind==='stalk'?1.20:1.95;
  if(scheduled.end<=limit&&distance<=(scheduled.end-start)*speedLimit&&safeRecovery(to,scheduled,land,angleAt,side,hop))return scheduled;

  // If the next beat is too short, leave at its usual time and take a slower walk.
  for(const seconds of [1.15,1.45,1.80,2.20,2.65,3.10]) {
    const end=start+seconds;
    if(end>limit)break;
    const target=sample(end);
    const prior=sample(end-.12);
    const airborne=target.flight>0&&target.flight<1;
    if(airborne||Math.hypot(target.x-prior.x,target.z-prior.z)>.045)continue;
    const walk={kind:'walk',start,end,target};
    if(Math.hypot(target.x-to.x,target.z-to.z)<=seconds*.90&&safeRecovery(to,walk,land,angleAt,side,hop))return walk;
  }
  return null;
}

function planJump(crossing,side,sample,nextTravel,angleAt,hop,radius) {
  let best=null, bestScore=Infinity;
  for(const [seconds,faceSeconds] of jumpTimings)for(let lead=.23;lead<=foxtailJumpWindow.before;lead+=.045) {
    const start=crossing-lead;
    const from=sample(start);
    if(from.flight>0&&from.flight<1)continue;
    const hopStart=start+faceSeconds;
    const launch=hopStart+hop.launch*seconds;
    const land=hopStart+hop.land*seconds;
    const apexAngle=angleAt((launch+land)*.5);
    const gap=across(from,apexAngle);
    if(side*gap<.24||side*gap>1.39)continue;
    if(side*across(from,angleAt(start))<clearance||side*across(from,angleAt(launch))<clearance)continue;
    // Mirror the takeoff point across the pole at the top of the jump.
    const to={x:from.x+2*gap*Math.sin(apexAngle),z:from.z-2*gap*Math.cos(apexAngle)};
    if(Math.hypot(to.x,to.z)>radius-.35||side*across(to,angleAt(land))>-.26)continue;
    let clears=true;
    for(let i=1;i<20;i++) {
      const flight=i/20;
      const height=4*foxtailJumpHeight*flight*(1-flight);
      if(height<.34&&Math.abs(across(between(from,to,flight),angleAt(mix(launch,land,flight))))<clearance) {
        clears=false; break;
      }
    }
    if(!clears)continue;
    const hopEnd=hopStart+seconds;
    // Resume on a scheduled move. Its starting point is the new resting spot.
    let after=hopEnd+sitSeconds+restSeconds+standSeconds;
    for(let attempt=0;attempt<3;attempt++) {
      const scheduled=nextTravel(after);
      const limit=crossing+foxtailJumpWindow.after;
      if(!scheduled||scheduled.start>=limit)break;
      after=scheduled.end+.001;
      const move=recoveryMove(to,scheduled,sample,land,limit,angleAt,side,hop);
      if(!move)continue;
      const distance=Math.hypot(move.target.x-to.x,move.target.z-to.z);
      const score=Math.abs(Math.abs(gap)-.39)*1.8+distance*.14+Math.abs(1.52-seconds)*.65
        +Math.abs(.36-faceSeconds)*.44+(move.start-hopEnd)*.025+(move===scheduled?0:.13);
      if(score<bestScore) {
        bestScore=score;
        best={start,hopStart,seconds,land,end:move.end,from,to,move,distance,
          heading:-Math.atan2(to.z-from.z,to.x-from.x),
          moveHeading:distance>.025?-Math.atan2(move.target.z-to.z,move.target.x-to.x):move.target.heading};
      }
      break;
    }
  }
  return best;
}

export function planFoxtailJumps(sample,nextTravel,angleAt,start,end,hop,radius) {
  const plans=[];
  const steps=Math.ceil((end-start)*24);
  let previousTime=start, previousGap=across(sample(start),angleAt(start));
  for(let i=1;i<=steps;i++) {
    const time=mix(start,end,i/steps);
    const gap=across(sample(time),angleAt(time));
    if((previousGap>0)!==(gap>0)) {
      let a=previousTime,b=time;
      for(let j=0;j<12;j++) {
        const mid=(a+b)*.5;
        if((across(sample(mid),angleAt(mid))>0)===(previousGap>0))a=mid;
        else b=mid;
      }
      const crossing=(a+b)*.5;
      const point=sample(crossing), angle=angleAt(crossing);
      const along=point.x*Math.cos(angle)+point.z*Math.sin(angle);
      if(along>1.02&&along<5.65) {
        const plan=planJump(crossing,previousGap>0?1:-1,sample,nextTravel,angleAt,hop,radius);
        if(plan&&(!plans.length||plan.start>=plans.at(-1).end))plans.push(plan);
      }
    }
    previousTime=time;previousGap=gap;
  }
  return plans;
}

export function foxtailJumpAction(plan,time,hop) {
  const {start,hopStart,seconds,from,to,move,heading,moveHeading,distance}=plan;
  const hopEnd=hopStart+seconds;
  if(time<hopStart) {
    const blend=ease(progressAt(time,start,hopStart));
    return blendPose(from,1-blend,turn(from.heading,heading,blend));
  }
  if(time<hopEnd) {
    const progress=progressAt(time,hopStart,hopEnd);
    const flight=progressAt(progress,hop.launch,hop.land);
    return {...between(from,to,flight),kind:'poleJump',progress,sitting:0,heading,distance:Math.hypot(to.x-from.x,to.z-from.z)};
  }
  if(time<move.start) {
    const stand=ease(progressAt(time,move.start-standSeconds,move.start));
    const sitting=ease(progressAt(time,hopEnd,hopEnd+sitSeconds))*(1-stand);
    return {...to,kind:'idle',progress:0,sitting,heading:turn(heading,moveHeading,stand),distance:0};
  }
  const progress=progressAt(time,move.start,move.end);
  const realign=ease(progressAt(progress,.90,1));
  return {...between(to,move.target,travelProgress(move.kind,progress,hop)),kind:move.kind,progress,sitting:0,
    heading:turn(moveHeading,move.target.heading,realign),distance};
}
