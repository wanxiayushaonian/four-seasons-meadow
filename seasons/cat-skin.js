import * as THREE from './vendor/three.module.js';

const spacing=.012;
const edges=[
  [0,1],[2,3],[4,5],[6,7],
  [0,2],[1,3],[4,6],[5,7],
  [0,4],[1,5],[2,6],[3,7],
];

function prepareVolumes(parent,volumes,bones) {
  const inverseParent=parent.matrixWorld.clone().invert();
  const min=new THREE.Vector3(Infinity,Infinity,Infinity);
  const max=new THREE.Vector3(-Infinity,-Infinity,-Infinity);
  const position=new THREE.Vector3(), scale=new THREE.Vector3();
  const orientation=new THREE.Quaternion(), axis=new THREE.Vector3(0,0,1);
  const transform=new THREE.Matrix4();
  const shapes=volumes.map(({bone,center,radii,tilt=0})=>{
    transform.compose(position.fromArray(center),orientation.setFromAxisAngle(axis,tilt),scale.fromArray(radii));
    transform.premultiply(bone.matrixWorld).premultiply(inverseParent);
    const m=transform.elements;
    for(let i=0;i<3;i++) {
      const extent=Math.hypot(m[i],m[i+4],m[i+8]);
      min.setComponent(i,Math.min(min.getComponent(i),m[i+12]-extent));
      max.setComponent(i,Math.max(max.getComponent(i),m[i+12]+extent));
    }
    const radius=Math.min(Math.hypot(m[0],m[1],m[2]),Math.hypot(m[4],m[5],m[6]),Math.hypot(m[8],m[9],m[10]));
    return {inverse:transform.clone().invert().elements,bone:bones.indexOf(bone),radius,blend:Math.min(.043,.009+.85*radius)};
  });
  min.addScalar(-.048);
  max.addScalar(.048);
  return {shapes,min,max};
}

function distanceToVolume(shape,x,y,z) {
  const m=shape.inverse;
  const a=m[0]*x+m[4]*y+m[8]*z+m[12];
  const b=m[1]*x+m[5]*y+m[9]*z+m[13];
  const c=m[2]*x+m[6]*y+m[10]*z+m[14];
  return (Math.sqrt(a*a+b*b+c*c)-1)*shape.radius;
}

function makeSkinGeometry(parent,volumes,bones) {
  const {shapes,min,max}=prepareVolumes(parent,volumes,bones);
  const [nx,ny,nz]=max.sub(min).toArray().map(size=>Math.ceil(size/spacing)+1);
  const gridStep=[1,nx,nx*ny];
  const field=new Float32Array(nx*ny*nz);
  for(let k=0,index=0;k<nz;k++)for(let j=0;j<ny;j++)for(let i=0;i<nx;i++,index++) {
    const x=min.x+i*spacing,y=min.y+j*spacing,z=min.z+k*spacing;
    let distance=Infinity;
    for(const shape of shapes) {
      const d=distanceToVolume(shape,x,y,z);
      // Smooth unions weld the shoulders, neck and feet into the same surface.
      const overlap=Math.max(shape.blend-Math.abs(distance-d),0);
      distance=Math.min(distance,d)-overlap*overlap/(4*shape.blend);
    }
    field[index]=distance;
  }

  const corners=Array.from({length:8},(_,i)=>(i&1)+((i>>1)&1)*nx+((i>>2)&1)*nx*ny);
  const cellStep=[1,nx-1,(nx-1)*(ny-1)];
  const cells=new Int32Array((nx-1)*(ny-1)*(nz-1)).fill(-1);
  const positions=[],indices=[];
  const values=new Float32Array(8),coord=[0,0,0];
  for(let k=0,cell=0;k<nz-1;k++)for(let j=0;j<ny-1;j++)for(let i=0;i<nx-1;i++,cell++) {
    const start=(k*ny+j)*nx+i;
    let mask=0;
    for(let c=0;c<8;c++) {
      values[c]=field[start+corners[c]];
      if(values[c]<0)mask|=1<<c;
    }
    if(mask===0||mask===255)continue;
    let x=0,y=0,z=0,count=0;
    for(const [a,b] of edges) {
      if((values[a]<0)===(values[b]<0))continue;
      const t=values[a]/(values[a]-values[b]);
      x+=THREE.MathUtils.lerp(a&1,b&1,t);
      y+=THREE.MathUtils.lerp((a>>1)&1,(b>>1)&1,t);
      z+=THREE.MathUtils.lerp((a>>2)&1,(b>>2)&1,t);
      count++;
    }
    const vertex=positions.length/3;
    cells[cell]=vertex;
    positions.push(min.x+(i+x/count)*spacing,min.y+(j+y/count)*spacing,min.z+(k+z/count)*spacing);
    coord[0]=i; coord[1]=j; coord[2]=k;
    // Connect the four neighboring cells around each crossed grid edge.
    for(let axis=0;axis<3;axis++) {
      const a=(axis+1)%3,b=(axis+2)%3;
      if(!coord[a]||!coord[b]||(values[0]<0)===(field[start+gridStep[axis]]<0))continue;
      const first=cells[cell-cellStep[a]],second=cells[cell-cellStep[a]-cellStep[b]],third=cells[cell-cellStep[b]];
      if(values[0]<0)indices.push(vertex,first,second,vertex,second,third);
      else indices.push(vertex,third,second,vertex,second,first);
    }
  }

  const skinIndex=[],skinWeight=[];
  const distanceByBone=new Float32Array(bones.length);
  const ranked=bones.map((_,i)=>i);
  const weights=new Float32Array(4);
  for(let i=0;i<positions.length;i+=3) {
    distanceByBone.fill(Infinity);
    for(const shape of shapes) {
      const d=distanceToVolume(shape,positions[i],positions[i+1],positions[i+2]);
      distanceByBone[shape.bone]=Math.min(distanceByBone[shape.bone],d);
    }
    ranked.sort((a,b)=>distanceByBone[a]-distanceByBone[b]);
    const nearest=distanceByBone[ranked[0]];
    let sum=0;
    for(let j=0;j<4;j++) {
      const bone=ranked[j];
      weights[j]=1-THREE.MathUtils.smoothstep(distanceByBone[bone]-nearest,0,.032);
      sum+=weights[j];
      skinIndex.push(bone);
    }
    for(const weight of weights)skinWeight.push(weight/sum);
  }

  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(skinIndex,4));
  geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(skinWeight,4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export function makeCatSkin(parent,volumes,material,sharedGeometry) {
  parent.updateWorldMatrix(true,true);
  const bones=[...new Set(volumes.map(volume=>volume.bone))];
  const geometry=sharedGeometry??makeSkinGeometry(parent,volumes,bones);
  const skin=new THREE.SkinnedMesh(geometry,material);
  skin.frustumCulled=false;
  parent.add(skin);
  skin.bind(new THREE.Skeleton(bones));
  return skin;
}
