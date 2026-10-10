/* FLOAT: raymarched underwater single scattering, full-4K HDR composition.
 * HDR API: https://developer.chrome.com/blog/new-in-webgpu-129
 * Configuration: https://www.w3.org/TR/webgpu/#gpucanvasconfiguration
 * No animation loop here: stage.js owns the monitor-synchronized RAF.
 * Technique references (no source copied):
 * https://threejs.org/examples/webgpu_volume_lighting.html (quarter-res volume)
 * https://threejs.org/examples/webgpu_volume_caustics.html (refraction/volume)
 * https://threejs.org/examples/webgpu_water.html (flow/normals/Fresnel)
 * https://pbr-book.org/4ed/Volume_Scattering/Transmittance
 * https://pbr-book.org/3ed-2018/Volume_Scattering/Phase_Functions
 * Shader craft guidance: spaceplayentry/minimax-shader-dev@0.1.1 (MIT).
 * GPU timing: https://developer.chrome.com/blog/new-in-webgpu-121
 * Canvas copy: https://developer.mozilla.org/en-US/docs/Web/API/GPUQueue/copyExternalImageToTexture
 * Original center-radial text scattering follows the formulas discussed at
 * https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process
 * RGB matrices: https://github.com/w3c/csswg-drafts/blob/main/css-color-4/conversions.js
 */
(() => {
  'use strict';
  const common = /* wgsl */ `
struct Settings {
  frame: vec4f, // width, height, seconds, actual audio energy
  palette: vec4f, // three hue turns, HDR enabled
  motion: vec4f, // normalized pointer, waveform role, highlight gain
  effects: vec4f, // internal light-field width, height, integration steps
  foci: array<vec4f,6>, // world-space light-pool center, width and lifecycle gain
  waterTint: vec4f, // linear color RGB, A indicates supplied foreground-alpha readiness
  deepTint: vec4f,
  sunTint: vec4f,
  reflectionTint: vec4f,
  oceanStops: array<vec4f,4>,
  rayMotion: vec4f, // music-integrated position seconds/speed; separate from ambient time
};
@group(0) @binding(0) var<uniform> s: Settings;
struct Vertex { @builtin(position) position: vec4f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> Vertex {
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  var out: Vertex;
  out.position = vec4f(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
  return out;
}
fn encode(c: vec3f) -> vec3f {
  // Canvas display-p3 uses the sRGB transfer curve, with extended values.
  return select(c * 12.92, 1.055 * pow(max(c, vec3f(0.0)), vec3f(0.4166667)) - 0.055, c > vec3f(0.0031308));
}
fn expectedOcean(uv: vec2f) -> vec3f {
  let y=clamp(uv.y,0.0,1.0);
  if(y<0.18) { return mix(s.oceanStops[0].rgb,s.oceanStops[1].rgb,y/0.18); }
  if(y<0.53) { return mix(s.oceanStops[1].rgb,s.oceanStops[2].rgb,(y-0.18)/0.35); }
  return mix(s.oceanStops[2].rgb,s.oceanStops[3].rgb,(y-0.53)/0.47);
}
fn glyphMask(color: vec3f,uv: vec2f) -> f32 {
  // Only near-neutral white foreground cores exceed this threshold. The
  // ocean's palette-dependent luminance is subtracted, so emerald/sunset
  // water and translucent bubble glints do not become letter light sources.
  let minimum=min(color.r,min(color.g,color.b));
  let luma=dot(color,vec3f(0.2126,0.7152,0.0722));
  let oceanLuma=dot(expectedOcean(uv),vec3f(0.2126,0.7152,0.0722));
  let contrast=clamp((luma-oceanLuma)/max(0.06,1.0-oceanLuma),0.0,1.0);
  return smoothstep(0.68,0.90,minimum)*smoothstep(0.12,0.38,contrast);
}
struct WaterSample { height: f32, slope: vec2f, curve: vec3f };
fn waterFlow(time: f32) -> vec2f {
  return vec2f(time*0.12,time*0.026)+vec2f(sin(time*0.085),cos(time*0.063))*0.18;
}
fn waterWave(q0: vec2f,time: f32) -> WaterSample {
  let q=q0-waterFlow(time);
  let da=vec2f(1.8,0.42);
  let db=vec2f(-3.4,0.97);
  let dc=vec2f(5.1,-0.68);
  let a=dot(q,da)-time*0.47;
  let b=dot(q,db)+time*0.36;
  let c=dot(q,dc)-time*0.29;
  let ha=sin(a)*0.070;
  let hb=sin(b)*0.036;
  let hc=sin(c)*0.021;
  let slope=da*cos(a)*0.070+db*cos(b)*0.036+dc*cos(c)*0.021;
  let curve=-ha*vec3f(da.x*da.x,da.y*da.y,da.x*da.y)
    -hb*vec3f(db.x*db.x,db.y*db.y,db.x*db.y)
    -hc*vec3f(dc.x*dc.x,dc.y*dc.y,dc.x*dc.y);
  return WaterSample(ha+hb+hc,slope,curve);
}
fn cameraPosition() -> vec3f {
  return vec3f((s.motion.x-0.5)*0.08,0.96+(s.motion.y-0.5)*0.04,-2.5);
}
fn cameraDirection(uv: vec2f) -> vec3f {
  return normalize(vec3f((uv.x-0.5)*(s.frame.x/s.frame.y)*1.28,(uv.y-0.34)*1.56,1.70));
}
fn waterIntersection(origin: vec3f,direction: vec3f,time: f32) -> f32 {
  let vertical=max(-direction.y,0.018);
  let planeDistance=origin.y/vertical;
  if(planeDistance>=35.0) { return 36.0; }
  // Wave amplitude is bounded by 0.127m. Bracket the real surface before
  // refining; unconstrained Newton steps jump at grazing-angle wave crests.
  var nearDistance=max(0.05,(origin.y-0.132)/vertical);
  var farDistance=min(36.0,(origin.y+0.132)/vertical);
  for(var i=0u;i<7u;i=i+1u) {
    let middle=(nearDistance+farDistance)*0.5;
    let point=origin+direction*middle;
    let wave=waterWave(point.xz,time);
    if(point.y>wave.height) { nearDistance=middle; } else { farDistance=middle; }
  }
  let middle=(nearDistance+farDistance)*0.5;
  let point=origin+direction*middle;
  let wave=waterWave(point.xz,time);
  let derivative=direction.y-dot(wave.slope,direction.xz);
  let safeDerivative=select(max(derivative,0.018),min(derivative,-0.018),derivative<0.0);
  return clamp(middle-(point.y-wave.height)/safeDerivative,nearDistance,farDistance);
}
`;

  const cookieShader = common + /* wgsl */ `
@group(1) @binding(0) var densityField: texture_3d<f32>;
@group(1) @binding(1) var densitySampler: sampler;
@fragment fn fsCookie(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  let uv=pixel.xy/vec2f(512.0);
  let q0=(uv-vec2f(0.5))*18.0;
  let flow=waterFlow(s.rayMotion.x);
  let warp=textureSampleLevel(densityField,densitySampler,vec3f((q0-flow)*0.055,s.rayMotion.x*0.002),0.0).r;
  let q=q0+vec2f(warp-0.5,(warp-0.5)*0.4)*0.60;
  // Long, irregular wave crests refract moving pools of sunlight; the optical
  // Jacobian focuses only narrow folds. Empty water receives almost no light.
  let wave=waterWave(q,s.rayMotion.x);
  let r=1.28;
  let jacobian=(1.0-r*wave.curve.x)*(1.0-r*wave.curve.y)-r*r*wave.curve.z*wave.curve.z;
  let focus=1.0/sqrt(jacobian*jacobian+0.016);
  let transmission=pow(clamp((focus-0.47)*0.26,0.0,1.0),2.4);
  // Advected pools of surface illumination are born at new positions, travel
  // with the water and die smoothly. Their centers really move in world space.
  var aperture=0.08;
  for(var i=0u;i<6u;i=i+1u) {
    let lens=s.foci[i];
    let delta=(q-lens.xy)/vec2f(lens.z,3.6);
    aperture+=exp(-dot(delta,delta))*lens.w;
  }
  return vec4f(transmission*min(aperture,1.25)*6.2,wave.slope,1.0);
}`;

  const volumeShader = common + /* wgsl */ `
@group(1) @binding(0) var densityField: texture_3d<f32>;
@group(1) @binding(1) var densitySampler: sampler;
@group(1) @binding(2) var sunlightCookie: texture_2d<f32>;
@group(1) @binding(3) var sunlightSampler: sampler;
fn densityAt(p: vec3f, time: f32) -> f32 {
  let drift = vec3f(time * 0.0012, time * 0.0007, -time * 0.0009);
  let a = textureSampleLevel(densityField, densitySampler, p * 0.092 + drift, 0.0).r;
  return 0.76 + a * 0.42;
}
fn phaseHG(cosTheta: f32) -> f32 {
  let g = 0.66;
  let denominator = max(1.0 + g*g - 2.0*g*cosTheta, 0.01);
  return (1.0 - g*g) / (12.5663706 * denominator * sqrt(denominator));
}
@fragment fn fsVolume(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  let uv = pixel.xy / s.effects.xy;
  let camera=cameraPosition();
  let direction=cameraDirection(uv);
  // Sunlight travels down toward the viewer: forward scattering is strongest
  // near the surface rather than behind the virtual camera.
  let sunDirection = normalize(vec3f(0.24, 1.0, -0.65));
  let phase = phaseHG(dot(sunDirection, -direction));
  let steps=20u;
  // Fit the integration interval to the actual water-surface intersection.
  // An integer early-exit count produces visible terraces across the surface.
  var rayLength=7.2;
  if(direction.y< -0.018) { rayLength=min(7.2,waterIntersection(camera,direction,s.frame.z)); }
  let stepLength = rayLength / f32(steps);
  // Deterministic midpoint quadrature preserves a continuous light field.
  // No random per-pixel integration grain or integer water-boundary exits.
  var transmittance = vec3f(1.0);
  var radiance = vec3f(0.0);
  let waterMaximum=max(0.05,max(s.waterTint.r,max(s.waterTint.g,s.waterTint.b)));
  let waterColor=s.waterTint.rgb/waterMaximum;
  let sigmaA=vec3f(0.04)+(vec3f(1.0)-waterColor)*0.17;
  let sigmaS=vec3f(0.045)+waterColor*0.055;
  let sigmaT = sigmaA + sigmaS;
  let sunPower = mix(6.0, 38.0, s.palette.w) * (0.94 + s.frame.w*0.12);
  let lightStep=exp(-sigmaT*(direction.y*stepLength/sunDirection.y)*0.78);
  var lightTransmission=exp(-sigmaT*((camera.y+direction.y*stepLength*0.5)/sunDirection.y)*0.78);
  for(var i=0u; i<steps; i=i+1u) {
    let distance=(f32(i)+0.5)*stepLength;
    let p = camera + direction*distance;
    let density = densityAt(p, s.frame.z);
    let surfacePoint = p.xz - sunDirection.xz * p.y / sunDirection.y;
    let irradiance=textureSampleLevel(sunlightCookie,sunlightSampler,surfacePoint/18.0+vec2f(0.5),0.0).r;
    let sunlight=s.sunTint.rgb*lightTransmission*irradiance*sunPower;
    let incident=sunlight*phase+s.deepTint.rgb*0.07;
    let localExtinction = sigmaT * density;
    let stepTransmission = exp(-localExtinction * stepLength);
    let integral = (vec3f(1.0)-stepTransmission) / max(localExtinction,vec3f(0.0001));
    radiance += transmittance * incident * sigmaS * density * integral;
    transmittance *= stepTransmission;
    lightTransmission *= lightStep;
  }
  let opticalOpacity = 1.0-dot(transmittance,vec3f(0.2126,0.7152,0.0722));
  return vec4f(radiance, opticalOpacity);
}`;

  const textMaskShader=common+/* wgsl */ `
@group(1) @binding(0) var maskSource: texture_2d<f32>;
@group(1) @binding(1) var maskSampler: sampler;
@group(1) @binding(2) var combinedWaveMask: texture_2d<f32>;
fn gaussianWeight(index: u32) -> f32 {
  let weights=array<f32,5>(0.2504,0.20598,0.11465,0.04317,0.01100);
  return weights[index];
}
fn glyphAlphaMask(uv: vec2f) -> f32 {
  if(any(uv<vec2f(0.0))||any(uv>vec2f(1.0))) { return 0.0; }
  if((s.motion.z>0.5&&s.motion.z<1.5)||s.waterTint.a<0.5) { return 0.0; }
  return textureSampleLevel(maskSource,maskSampler,uv,0.0).a;
}
fn waveAlphaMask(uv: vec2f) -> f32 {
  if(any(uv<vec2f(0.0))||any(uv>vec2f(1.0))||s.motion.z<0.5) { return 0.0; }
  if(s.motion.z<1.5) {
    if(s.waterTint.a<0.5) { return 0.0; }
    return textureSampleLevel(maskSource,maskSampler,uv,0.0).a;
  }
  if(s.rayMotion.w<0.5) { return 0.0; }
  return textureSampleLevel(combinedWaveMask,maskSampler,uv,0.0).a;
}
fn diffusedMask(uv: vec2f) -> vec2f {
  if(any(uv<vec2f(0.0))||any(uv>vec2f(1.0))) { return vec2f(0.0); }
  return textureSampleLevel(maskSource,maskSampler,uv,0.0).rg;
}
@fragment fn fsMaskHorizontal(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  let uv=pixel.xy/s.effects.xy;
  let glyphStep=vec2f(1.5/s.effects.x,0.0);
  let waveStep=vec2f(2.5/s.effects.x,0.0);
  var mask=vec2f(glyphAlphaMask(uv),waveAlphaMask(uv))*gaussianWeight(0u);
  for(var i=1u;i<5u;i=i+1u) {
    let glyphOffset=glyphStep*f32(i);
    let waveOffset=waveStep*f32(i);
    if(s.motion.z<0.5||s.motion.z>1.5) {
      mask.x+=(glyphAlphaMask(uv-glyphOffset)+glyphAlphaMask(uv+glyphOffset))*gaussianWeight(i);
    }
    if(s.motion.z>0.5) {
      mask.y+=(waveAlphaMask(uv-waveOffset)+waveAlphaMask(uv+waveOffset))*gaussianWeight(i);
    }
  }
  return vec4f(mask,0.0,1.0);
}
@fragment fn fsMaskVertical(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  let uv=pixel.xy/s.effects.xy;
  let glyphStep=vec2f(0.0,1.5/s.effects.y);
  let waveStep=vec2f(0.0,2.5/s.effects.y);
  var mask=diffusedMask(uv)*gaussianWeight(0u);
  for(var i=1u;i<5u;i=i+1u) {
    let glyphOffset=glyphStep*f32(i);
    let waveOffset=waveStep*f32(i);
    if(s.motion.z<0.5||s.motion.z>1.5) {
      mask.x+=(diffusedMask(uv-glyphOffset).x+diffusedMask(uv+glyphOffset).x)*gaussianWeight(i);
    }
    if(s.motion.z>0.5) {
      mask.y+=(diffusedMask(uv-waveOffset).y+diffusedMask(uv+waveOffset).y)*gaussianWeight(i);
    }
  }
  return vec4f(mask,0.0,1.0);
}`;

  const textLightShader=common+/* wgsl */ `
@group(1) @binding(0) var foreground: texture_2d<f32>;
@group(1) @binding(1) var foregroundSampler: sampler;
@fragment fn fsTextLight(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  let uv=pixel.xy/s.effects.xy;
  let pivot=vec2f(0.5,0.5);
  let density=select(select(0.88,0.94,s.motion.z>0.5),0.91,s.motion.z>1.5);
  let delta=(uv-pivot)*(density/96.0);
  let diffuseWaveCore=textureSampleLevel(foreground,foregroundSampler,uv,0.0).g;
  var coordinate=uv;
  var illumination=vec2f(0.0);
  var occlusion=vec2f(0.0);
  var attenuation=1.0;
  for(var i=0u;i<96u;i=i+1u) {
    coordinate-=delta;
    let mask=textureSampleLevel(foreground,foregroundSampler,coordinate,0.0).rg;
    // Sample-count normalization and matched continuous extinction prevent
    // brighter output when the integration density increases threefold.
    illumination+=mask*attenuation*(0.026/3.0);
    occlusion+=mask*attenuation/96.0;
    attenuation*=0.98511;
  }
  // Only the twice-diffused scalar source is scattered. No original glyph
  // image or sharp letter outline is additively copied into this field.
  // Latest text exposure is slightly lower than v8; waveform rays use 30% of
  // that exposure and stay soft. Neither source reads the displayed opacity.
  // Pack independent layers: glyph emission, combined shadow, wave shoulders,
  // wave emission. Both channels share this one radial integration pass.
  // Wave light is additive only: it never contributes a negative shadow field.
  return vec4f(illumination.x*1.52,occlusion.x,diffuseWaveCore,illumination.y*1.52*0.35);
}`;

  const compositeShader = common + /* wgsl */ `
@group(1) @binding(0) var atmosphere: texture_2d<f32>;
@group(1) @binding(1) var atmosphereSampler: sampler;
@group(1) @binding(2) var stageBase: texture_2d<f32>;
@group(1) @binding(3) var stageBaseSampler: sampler;
@group(1) @binding(4) var textLight: texture_2d<f32>;
@group(1) @binding(5) var textLightSampler: sampler;
@group(1) @binding(6) var foregroundAlpha: texture_2d<f32>;
@group(1) @binding(7) var foregroundAlphaSampler: sampler;
struct SurfaceLight { radiance: vec3f, distortion: vec2f, weight: f32 };
fn surfaceLighting(uv: vec2f) -> SurfaceLight {
  var result=SurfaceLight(vec3f(0.0),vec2f(0.0),0.0);
  let origin=cameraPosition();
  let direction=cameraDirection(uv);
  if(direction.y>= -0.025) { return result; }
  let distance=waterIntersection(origin,direction,s.frame.z);
  let point=origin+direction*distance;
  let wave=waterWave(point.xz,s.frame.z);
  let q=point.xz-waterFlow(s.frame.z);
  let microDetail=1.0-smoothstep(8.0,26.0,distance);
  let smallA=dot(q,vec2f(11.8,4.1))-s.frame.z*0.94;
  let smallB=dot(q,vec2f(-8.7,15.3))+s.frame.z*0.72;
  let slope=wave.slope+vec2f(0.029*cos(smallA),0.023*cos(smallB))*microDetail;
  let normal=normalize(vec3f(-slope.x,1.0,-slope.y));
  let reflected=reflect(direction,normal);
  let refracted=refract(direction,normal,1.333);
  let cosine=clamp(abs(dot(-direction,normal)),0.0,1.0);
  let schlick=0.0204+0.9796*pow(1.0-cosine,5.0);
  let fresnel=select(schlick,1.0,dot(refracted,refracted)<0.001);
  let reflectionDepth=clamp(0.90-reflected.y*0.85,0.0,1.0);
  let reflectedWater=mix(s.deepTint.rgb*0.85,s.reflectionTint.rgb*0.72,reflectionDepth);
  let sky=(s.reflectionTint.rgb*0.65+s.sunTint.rgb*0.18)*(0.32+0.68*clamp(-refracted.y,0.0,1.0));
  let environment=mix(sky,reflectedWater,fresnel);
  let sunReflection=normalize(vec3f(-0.19,0.68,0.72));
  let alignment=max(dot(reflected,sunReflection),0.0);
  let specular=pow(alignment,58.0)*mix(0.55,3.1,s.palette.w);
  let softSpecular=pow(alignment,9.0)*0.105;
  let weight=(1.0-smoothstep(15.0,34.0,distance))*smoothstep(0.025,0.17,-direction.y);
  result.radiance=environment*0.24+s.sunTint.rgb*(specular+softSpecular)*fresnel;
  result.distortion=normal.xz*0.0018*weight;
  result.weight=weight;
  return result;
}
@fragment fn fsComposite(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  let uv = pixel.xy / s.frame.xy;
  // Atmospheric radiance is low-frequency. One hardware-bilinear lookup avoids
  // a 5x texture bandwidth penalty at full 4K; sharp text lives on its own layer.
  let field=textureSampleLevel(atmosphere,atmosphereSampler,uv,0.0);
  let text=textureSampleLevel(textLight,textLightSampler,uv,0.0);
  // Surface normals/reflection/refraction are evaluated at native 4K pixels,
  // never by rotating/upscaling the atmospheric texture.
  let water=surfaceLighting(uv);
  let light=max(field.r,max(field.g,field.b));
  let alpha=clamp(field.a*0.22+light*0.022,0.02,0.30);
  let radialShadow=clamp(text.g*0.28,0.0,0.14);
  let oceanRayScale=select(1.0,0.80,s.motion.z>0.5);
  let glyphEmission=s.sunTint.rgb*text.r*mix(0.65,1.5,s.palette.w);
  let waveEmission=s.sunTint.rgb*text.a*mix(0.65,1.5,s.palette.w);
  let textEmission=glyphEmission+waveEmission;
  let radiance=min(field.rgb*s.motion.w*oceanRayScale*(1.0-radialShadow)+water.radiance*water.weight+textEmission,vec3f(mix(0.95,7.0,s.palette.w)));
  if(s.effects.w>0.5) {
    // The imported rgba8unorm-srgb texture is encoded Display-P3. The texture
    // unit decodes its transfer curve, so base and scattering combine linearly.
    let waveAvailable=select(s.waterTint.a,s.rayMotion.w,s.motion.z>1.5);
    var anchorWaveAlpha=0.0;
    if(s.motion.z>0.5&&waveAvailable>0.5) {
      anchorWaveAlpha=textureSampleLevel(foregroundAlpha,foregroundAlphaSampler,uv,0.0).a;
    }
    // Wave geometry follows actual audio only. Keep surface refraction on the
    // ocean/lyrics but anchor the waveform to its unwarped live silhouette.
    // Warping an already composited waveform can fold its image into a second
    // silhouette outside the anchor mask. Keep that imported foreground stable;
    // the water surface and volumetric refraction still animate independently.
    let baseUV=select(uv+water.distortion,uv,s.motion.z>0.5);
    let base=textureSampleLevel(stageBase,stageBaseSampler,baseUV,0.0).rgb;
    var localGlyph=0.0;
    if(s.motion.z<0.5||s.motion.z>1.5) { localGlyph=glyphMask(base,baseUV); }
    var waveCore=0.0;
    var waveBand=0.0;
    var waveAlpha=0.0;
    if(s.motion.z>0.5&&waveAvailable>0.5) {
      waveAlpha=anchorWaveAlpha;
      waveBand=smoothstep(0.02,0.18,text.b);
      // Native4K pixel whiteness limits the positive lift to the real stroke;
      // the lower-resolution alpha cannot produce a second thick outline.
      waveCore=waveAlpha*smoothstep(0.50,0.80,min(base.r,min(base.g,base.b)));
    }
    if(s.motion.z>1.5) { localGlyph*=1.0-smoothstep(0.005,0.03,waveAlpha); }
    let behindWord=(1.0-localGlyph);
    // No wave-shaped background attenuation or dark band. Only the overall
    // background ray contribution is eased in waveform/combined mode.
    let shadedVolume=field.rgb*s.motion.w*oceanRayScale*(1.0-radialShadow)*behindWord;
    let surfaceLight=water.radiance*water.weight*behindWord;
    // In combined mode the wave is in front of the floating lyrics AND their
    // scattered rays, without duplicating either original foreground image.
    let glyphLight=glyphEmission*behindWord*(1.0-waveAlpha);
    let waveLight=waveEmission*behindWord*(1.0-max(waveCore,waveBand*0.65));
    let foregroundLight=glyphLight+waveLight;
    // Original crisp letters occur exactly once, in the native4K base. Preserve
    // their brightness rather than recreating a second additive white mask.
    let baseAttenuation=mix((1.0-alpha)*(1.0-water.weight*0.10),1.0,max(localGlyph,waveCore));
    let combined=base*baseAttenuation+shadedVolume+surfaceLight+foregroundLight;
    let coreWhite=vec3f(select(0.98,1.55,s.palette.w>0.5));
    let readable=mix(combined,max(combined,coreWhite),waveCore);
    return vec4f(encode(clamp(readable,vec3f(0.0),vec3f(mix(1.0,8.0,s.palette.w)))),1.0);
  }
  // field.rgb is integrated additive radiance. Divide before premultiplying
  // encoded color, so compositing preserves the physically computed light.
  let source = radiance / alpha;
  let display = select(min(source,vec3f(1.0)),source,s.palette.w>0.5);
  return vec4f(encode(max(display,vec3f(0.0)))*alpha,alpha);
}`;

  let canvas, context, device, uniform, pipeline, bindGroup;
  let volumePipeline, volumeGroup, volumeUniformGroup, volumeTexture, volumeView, densityTexture;
  let cookiePipeline,cookieGroup,cookieUniformGroup,cookieTexture,cookieView;
  let textPipeline,textUniformGroup,textSourceGroup,textTexture,textView,textEnabled=false;
  let maskHorizontalPipeline,maskVerticalPipeline,maskHorizontalUniform,maskVerticalUniform;
  let maskHorizontalSource,maskVerticalSource,maskHorizontalTexture,maskVerticalTexture,maskHorizontalView,maskVerticalView;
  let glyphAlphaTexture=null,glyphAlphaView=null;
  let combinedWaveTexture=null,combinedWaveView=null,combinedMode=false;
  let timing=null;
  let stageCanvas=null,stageOpacity='',baseTexture=null,opaqueMode=false,opaqueFallbackReason=null;
  let pending = null, generation = 0, lostHandlerDevice = null;
  let config = {}, pointer = {x:0.5,y:0.5};
  const values = new Float32Array(76);
  let lastRayMotionTime=null;
  const sourceRevision='float-hdr-stable-wave-foreground-v12';
  const shaderChecksum=(()=>{let hash=2166136261;for(const code of [common,cookieShader,volumeShader,textMaskShader,textLightShader,compositeShader])for(let i=0;i<code.length;i++)hash=Math.imul(hash^code.charCodeAt(i),16777619);return(hash>>>0).toString(16).padStart(8,'0')})();
  let lastUpdate = 0;
  const query = text => { try { return matchMedia(text).matches; } catch { return false; } };
  const status = {ready:false,format:null,toneMapping:'standard',dynamicRange:'standard',gamut:'srgb',deviceLost:false,error:null,width:0,height:0,refreshRate:0,frames:0,hdr:false,effectWidth:0,effectHeight:0,effectScale:1/3,integrationSteps:20,renderPasses:3,cookieWidth:512,cookieHeight:512,surfaceResolution:'native4K',surfaceModel:'analytic-wave-Fresnel-refraction',dynamicRays:true,lightPoolCount:6,cpuSubmitMs:0,frameIntervalMs:0,gpuFrameMs:null,gpuTimingSupported:false,gpuTimingSamples:0,gpuSampleFrame:null,gpuTimingError:null,adapter:null,requestedPowerPreference:'high-performance',compositionMode:'overlay',alphaMode:'premultiplied',baseCopyCpuMs:0,baseCopyError:null,baseTextureFormat:null,sourceRevision,shaderChecksum,textGodraysEnabled:false,waveGodraysEnabled:false,foregroundRayRole:null,textLightWidth:1,textLightHeight:1,textGodraySamples:96,textMaskBlurPasses:0,textDiffusionSigmaPixels:2.4,maskBlurSpacingPixels:1.5,textEmissionScale:1.52/2.4,textEmissionGainFromV8:1.52/1.728,waveEmissionScaleRelativeText:0.30,waveCoreProtectionMax:0.90,waveBandProtectionMax:0.75,textShadowLimit:0.14,textPivot:[0.5,0.5],textMaskSource:'projected-foreground-alpha-opacity-independent-separable-Gaussian',textMaskReady:false,textMaskWidth:0,textMaskHeight:0,textMaskFrames:0,textMaskCopyCpuMs:0,textMaskError:null,paletteHues:[194,211,178],timeOrigin:null,rayMotionTime:0,musicMotionSpeed:0,rayMotionPaused:false,rayPositionClock:'music-integrated-separate-from-ambient'};
  Object.assign(status,{combinedMode:false,packedForegroundMasks:'R:glyph G:wave',oceanPasses:3,foregroundLayerOrder:'glyphs behind waveform',waveEmissionScaleRelativeText:0.35,waveCoreProtectionMax:0,waveBandProtectionMax:0,waveShadowEnabled:false,waveHdrWhiteFloor:1.55,waveBackgroundRayScale:0.80,waveRefractionAnchored:true,waveMaskReady:false,waveMaskWidth:0,waveMaskHeight:0,waveMaskFrames:0,waveMaskCopyCpuMs:0,waveMaskError:null});
  const finite = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
  const clamp = (v, lo, hi) => Math.min(hi,Math.max(lo,v));
  function paletteLinear(hue,saturation,lightness) {
    // HSL sRGB -> linear sRGB -> XYZ D65 -> linear Display-P3. Matrix values
    // are the exact chromaticity-derived CSS Color4 matrices, not a tint clamp.
    const h=(((hue%360)+360)%360)/60,c=(1-Math.abs(2*lightness-1))*saturation;
    const x=c*(1-Math.abs(h%2-1)),m=lightness-c*.5;
    const sectors=[[c,x,0],[x,c,0],[0,c,x],[0,x,c],[x,0,c],[c,0,x]];
    const rgb=sectors[Math.floor(h)%6].map(v=>{const n=v+m;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4});
    if(status.gamut!=='display-p3')return rgb;
    const X=rgb[0]*(506752/1228815)+rgb[1]*(87881/245763)+rgb[2]*(12673/70218);
    const Y=rgb[0]*(87098/409605)+rgb[1]*(175762/245763)+rgb[2]*(12673/175545);
    const Z=rgb[0]*(7918/409605)+rgb[1]*(87881/737289)+rgb[2]*(1001167/1053270);
    return [X*(446124/178915)-Y*(333277/357830)-Z*(72051/178915),-X*(14852/17905)+Y*(63121/35810)+Z*(423/17905),X*(11844/330415)-Y*(50337/660830)+Z*(316169/330415)].map(v=>clamp(v,0,1));
  }
  function updatePalette(hues) {
    const h0=finite(hues[0],194),h1=finite(hues[1],211),h2=finite(hues[2],178);
    status.paletteHues=[h0,h1,h2];
    const colors=[paletteLinear(h0,.64,.46),paletteLinear(h1,.69,.20),paletteLinear(h0,.46,.86),paletteLinear(h0,.48,.61),paletteLinear(h0,.66,.75),paletteLinear(h0,.67,.52),paletteLinear(h1,.72,.35),paletteLinear(h1,.69,.20)];
    for(let i=0;i<colors.length;i++)values.set([...colors[i],1],40+i*4);
  }
  function updateLightPools(time,positionTime=time) {
    // Six cheap CPU state evaluations replace dozens of random/sine calls at
    // every surface texel. Epoch transitions occur only at zero envelope gain.
    const random=seed=>{const n=Math.sin(seed*127.1+311.7)*43758.5453;return n-Math.floor(n)};
    for(let i=0;i<6;i++) {
      const lifetime=15+i*1.7,worldClock=(time+i*4.6)/lifetime,worldAge=worldClock-Math.floor(worldClock);
      const spatialClock=(positionTime+i*4.6)/lifetime,epoch=Math.floor(spatialClock),age=spatialClock-epoch;
      const seed=i*53+epoch*79,phase=age*Math.PI+i;
      // Only advect during each pool's lifetime; cumulative day-long travel
      // would eventually move every illumination pool outside the visible sea.
      const flowX=age*lifetime*.12+Math.sin(positionTime*.085)*.18,flowZ=age*lifetime*.026+Math.cos(positionTime*.063)*.18;
      const x=random(seed+2)*12-6+(random(seed+8)-.5)*2*(age-.5)*3.1+Math.sin(phase)*.42+flowX*.22;
      const z=random(seed+5)*13-4+(random(seed+11)-.5)*.9*(age-.5)*3.1+Math.cos(phase)*.42+flowZ*.22;
      const fade=n=>{const v=clamp(n/0.10,0,1);return v*v*(3-2*v)};
      const birthGate=fade(age)*fade(1-age);
      // Ambient opacity continues on pause. New random positions are keyed
      // only to spatial epochs, and are invisible at epoch changes/resume.
      values.set([x,z,1.9+random(seed+15)*1.5,Math.sin(worldAge*Math.PI)**2*.88*birthGate],16+i*4);
    }
  }
  function releaseFields() {
    restoreStage();
    baseTexture?.destroy();
    textTexture?.destroy();
    maskHorizontalTexture?.destroy();
    maskVerticalTexture?.destroy();
    glyphAlphaTexture?.destroy();
    glyphAlphaTexture=glyphAlphaView=null;
    combinedWaveTexture?.destroy();
    combinedWaveTexture=combinedWaveView=null;
    baseTexture=null;
    textTexture=textView=textPipeline=textUniformGroup=textSourceGroup=null;
    maskHorizontalTexture=maskVerticalTexture=maskHorizontalView=maskVerticalView=null;
    maskHorizontalPipeline=maskVerticalPipeline=maskHorizontalUniform=maskVerticalUniform=maskHorizontalSource=maskVerticalSource=null;
    if(timing) {
      timing.active=false;
      timing.querySet.destroy();
      timing.resolveBuffer.destroy();
      timing.readBuffer.destroy();
      timing=null;
    }
    status.gpuFrameMs=null;
    volumeTexture?.destroy();
    densityTexture?.destroy();
    cookieTexture?.destroy();
    uniform?.destroy();
    volumeTexture = densityTexture = uniform = null;
    pipeline = bindGroup = volumePipeline = volumeGroup = volumeUniformGroup = volumeView = null;
    cookieTexture=cookieView=cookiePipeline=cookieGroup=cookieUniformGroup=null;
  }
  function restoreStage() {
    if(stageCanvas)stageCanvas.style.opacity=stageOpacity;
  }
  function fallbackOpaque(error) {
    opaqueFallbackReason=error?.message||String(error);
    status.baseCopyError=opaqueFallbackReason;
    restoreStage();
    hide(`Opaque composition unavailable: ${opaqueFallbackReason}`);
    opaqueMode=false;
    // Keep the already working HDR overlay as the reversible fallback.
    void init({...config,opaqueComposite:false}).then(()=> {
      status.compositionMode='overlay-fallback';
      status.baseCopyError=opaqueFallbackReason;
    });
  }
  function createTiming() {
    status.gpuTimingSupported=Boolean(device.features?.has('timestamp-query'));
    status.gpuTimingSamples=0;
    status.gpuSampleFrame=null;
    status.gpuTimingError=null;
    if(!status.gpuTimingSupported)return;
    timing={querySet:device.createQuerySet({label:'FLOAT three-pass GPU span',type:'timestamp',count:2}),
      resolveBuffer:device.createBuffer({label:'FLOAT timestamp resolve',size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC}),
      readBuffer:device.createBuffer({label:'FLOAT timestamp async readback',size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),
      busy:false,active:true};
  }
  async function readTiming(item,sampleFrame) {
    // Called after submit, never awaited by RAF. One 16-byte read every 60
    // frames; an in-flight map prevents overlap or reusing mapped memory.
    const token=generation;
    item.busy=true;
    try {
      await item.readBuffer.mapAsync(GPUMapMode.READ,0,16);
      const timestamps=new BigUint64Array(item.readBuffer.getMappedRange(0,16));
      const delta=timestamps[1]-timestamps[0];
      if(item.active&&timing===item&&token===generation) {
        // Counter reset/wrap and zero queries are not valid elapsed samples.
        if(timestamps[0]>0n&&timestamps[1]>0n&&delta>=0n&&delta<=1000000000n) {
          status.gpuFrameMs=Number(delta)/1000000;
          status.gpuTimingSamples++;
          status.gpuSampleFrame=sampleFrame;
          status.gpuTimingError=null;
        } else {
          status.gpuFrameMs=null;
          status.gpuTimingError='Invalid or reset GPU timestamp counter';
        }
      }
    } catch(error) {
      if(item.active&&timing===item&&token===generation) {
        status.gpuFrameMs=null;
        status.gpuTimingError=error.message||String(error);
      }
    } finally {
      try { if(item.readBuffer.mapState==='mapped')item.readBuffer.unmap(); } catch { /* Destroyed during reinitialization. */ }
      item.busy=false;
    }
  }
  function noiseVolume() {
    // Smooth periodic value noise, generated once. Linear 3D hardware sampling
    // is much cheaper and smoother than per-pixel multi-octave hash loops.
    const side=64, cells=8, lattice=new Float32Array(cells*cells*cells);
    for(let i=0;i<lattice.length;i++) {
      let h=Math.imul(i+19,0x45d9f3b);h=Math.imul(h^(h>>>16),0x45d9f3b);
      lattice[i]=((h^(h>>>16))>>>0)/4294967295;
    }
    const at=(x,y,z)=>lattice[(x%cells)+cells*((y%cells)+cells*(z%cells))];
    const mix=(a,b,t)=>a+(b-a)*t, smooth=t=>t*t*(3-2*t);
    const data=new Uint8Array(side*side*side);
    for(let z=0;z<side;z++)for(let y=0;y<side;y++)for(let x=0;x<side;x++) {
      const nx=x*cells/side,ny=y*cells/side,nz=z*cells/side;
      const ix=Math.floor(nx),iy=Math.floor(ny),iz=Math.floor(nz);
      const fx=smooth(nx-ix),fy=smooth(ny-iy),fz=smooth(nz-iz);
      const lower=mix(mix(at(ix,iy,iz),at(ix+1,iy,iz),fx),mix(at(ix,iy+1,iz),at(ix+1,iy+1,iz),fx),fy);
      const upper=mix(mix(at(ix,iy,iz+1),at(ix+1,iy,iz+1),fx),mix(at(ix,iy+1,iz+1),at(ix+1,iy+1,iz+1),fx),fy);
      data[x+side*(y+side*z)]=Math.round(mix(lower,upper,fz)*255);
    }
    const texture=device.createTexture({label:'FLOAT periodic water density',dimension:'3d',size:[side,side,side],format:'r8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    device.queue.writeTexture({texture},data,{bytesPerRow:side,rowsPerImage:side},[side,side,side]);
    return texture;
  }
  async function compile(code,label) {
    const module=device.createShaderModule({label,code});
    const info=await module.getCompilationInfo();
    const errors=info.messages.filter(message=>message.type==='error');
    if(errors.length)throw new Error(`${label}: `+errors.map(message=>`${message.lineNum}:${message.linePos} ${message.message}`).join('; '));
    return module;
  }
  function stats() { return {...status}; }
  function hide(message) {
    status.ready = false;
    status.hdr = false;
    status.error = message || null;
    if (canvas) canvas.style.visibility = 'hidden';
    restoreStage();
  }
  function surface() {
    canvas = document.getElementById('hdr-field');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'hdr-field';
      canvas.setAttribute('aria-hidden','true');
      document.body.append(canvas);
    }
    // No CSS filters or blend modes: either may force an SDR compositor pass.
    Object.assign(canvas.style,{position:'absolute',inset:'0',width:'100%',height:'100%',pointerEvents:'none',zIndex:'1',visibility:'hidden',background:'transparent'});
    return canvas.getContext('webgpu');
  }
  async function configure(useHDR) {
    const gamut = useHDR || query('(color-gamut: p3)') ? 'display-p3' : 'srgb';
    const format = useHDR ? 'rgba16float' : navigator.gpu.getPreferredCanvasFormat();
    const alphaMode=opaqueMode?'opaque':'premultiplied';
    const requested = {device,format,usage:GPUTextureUsage.RENDER_ATTACHMENT,alphaMode,colorSpace:gamut,toneMapping:{mode:useHDR?'extended':'standard'}};
    device.pushErrorScope('validation');
    let thrown = null;
    try { context.configure(requested); } catch (error) { thrown = error; }
    const validation = await device.popErrorScope();
    if (thrown || validation) throw thrown || new Error(validation.message);
    const actual = context.getConfiguration?.();
    if (useHDR && (!actual || actual.format !== 'rgba16float' || actual.alphaMode !== alphaMode || actual.toneMapping?.mode !== 'extended')) {
      throw new Error(`Extended-range ${alphaMode} canvas configuration was not confirmed`);
    }
    status.format = format;
    status.toneMapping = useHDR ? 'extended' : 'standard';
    status.gamut = gamut;
    status.hdr = useHDR;
    status.alphaMode=alphaMode;
    return format;
  }
  async function initialize(nextConfig) {
    const token = ++generation;
    config = {...nextConfig};
    hide(null);
    if(config.opaqueComposite)opaqueFallbackReason=null;
    stageCanvas=document.getElementById('stage');
    stageOpacity=stageCanvas?.style.opacity||'';
    opaqueMode=Boolean(config.opaqueComposite&&stageCanvas);
    const waveformRole=config.role==='waveform';
    combinedMode=config.role==='combined';
    status.combinedMode=combinedMode;
    status.textGodraysEnabled=opaqueMode&&!waveformRole&&config.textGodrays!==false;
    status.waveGodraysEnabled=opaqueMode&&(waveformRole||combinedMode)&&config.waveGodrays!==false;
    textEnabled=status.textGodraysEnabled||status.waveGodraysEnabled;
    status.foregroundRayRole=combinedMode?'combined':waveformRole?'waveform':'lyrics';
    status.textDiffusionSigmaPixels=waveformRole?4.0:2.4;
    status.maskBlurSpacingPixels=waveformRole?2.5:1.5;
    status.renderPasses=textEnabled?6:3;
    status.textMaskBlurPasses=textEnabled?2:0;
    status.textMaskReady=false;
    status.textMaskWidth=status.textMaskHeight=status.textMaskFrames=0;
    status.textMaskCopyCpuMs=0;
    status.textMaskError=null;
    status.waveMaskReady=false;
    status.waveMaskWidth=status.waveMaskHeight=status.waveMaskFrames=0;
    status.waveMaskCopyCpuMs=0;
    status.waveMaskError=null;
    status.timeOrigin=finite(config.timeOrigin,null);
    status.compositionMode=opaqueMode?'opaque-pending':opaqueFallbackReason?'overlay-fallback':'overlay';
    status.baseCopyError=opaqueFallbackReason;
    status.baseCopyCpuMs=0;
    status.deviceLost = false;
    status.dynamicRange = query('(dynamic-range: high)') ? 'high' : 'standard';
    status.refreshRate = Math.max(1,finite(config.refreshRate,60));
    if (!navigator.gpu) { hide('WebGPU unavailable'); return stats(); }
    try {
      context = surface();
      if (!context) throw new Error('WebGPU canvas unavailable');
      if (!device || status.deviceLost) {
        const adapter = await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
        if (!adapter) throw new Error('No hardware WebGPU adapter');
        const adapterInfo=adapter.info||(adapter.requestAdapterInfo?await adapter.requestAdapterInfo():null);
        status.adapter={vendor:adapterInfo?.vendor||null,device:adapterInfo?.device||null,architecture:adapterInfo?.architecture||null,description:adapterInfo?.description||null,isFallbackAdapter:adapterInfo?.isFallbackAdapter??adapter.isFallbackAdapter??null};
        if (status.adapter.isFallbackAdapter) throw new Error('Software WebGPU adapter disabled for 4K light field');
        const timestampAvailable=Boolean(adapter.features?.has('timestamp-query'));
        device=await adapter.requestDevice({requiredFeatures:timestampAvailable?['timestamp-query']:[]});
      }
      if (token !== generation) return stats();
      if (lostHandlerDevice !== device) {
        lostHandlerDevice = device;
        const activeDevice = device;
        device.lost.then(info => {
          if (device !== activeDevice) return;
          status.deviceLost = true;
          hide(`GPU device lost: ${info.reason}${info.message ? ' — '+info.message : ''}`);
          device = null;
        });
        device.addEventListener('uncapturederror', event => {
          event.preventDefault();
          if(opaqueMode&&status.ready){fallbackOpaque(new Error(event.error?.message||'GPU base canvas copy failed'));return;}
          hide(`WebGPU: ${event.error?.message || 'uncaptured error'}`);
        });
      }
      const portrait=config.role==='lyrics'||(combinedMode&&finite(globalThis.innerHeight,2160)>finite(globalThis.innerWidth,3840));
      canvas.width = Math.round(Math.max(1,finite(config.renderWidth,portrait?2160:3840)));
      canvas.height = Math.round(Math.max(1,finite(config.renderHeight,portrait?3840:2160)));
      if (Math.max(canvas.width,canvas.height) > device.limits.maxTextureDimension2D) throw new Error('GPU cannot allocate requested fixed 4K surface');
      status.width = canvas.width;
      status.height = canvas.height;
      let hdr = config.hdrCapable !== false && status.dynamicRange === 'high';
      let format;
      try { format = await configure(hdr); }
      catch (error) {
        if (!hdr) throw error;
        hdr = false;
        format = await configure(false);
        status.error = `HDR unavailable; SDR light field: ${error.message}`;
      }
      releaseFields();
      const [cookieModule,volumeModule,compositeModule,textModule,maskModule]=await Promise.all([
        compile(cookieShader,'FLOAT precomputed surface refraction'),
        compile(volumeShader,'FLOAT refractive volume integration'),
        compile(compositeShader,'FLOAT full4K HDR composition'),
        textEnabled?compile(textLightShader,'FLOAT center-pivot diffused text scattering'):Promise.resolve(null),
        textEnabled?compile(textMaskShader,'FLOAT separable text-mask diffusion'):Promise.resolve(null)
      ]);
      [cookiePipeline,volumePipeline,pipeline,textPipeline,maskHorizontalPipeline,maskVerticalPipeline]=await Promise.all([
        device.createRenderPipelineAsync({label:'FLOAT 512px advected sunlight cookie',layout:'auto',vertex:{module:cookieModule,entryPoint:'vs'},fragment:{module:cookieModule,entryPoint:'fsCookie',targets:[{format:'rgba16float'}]},primitive:{topology:'triangle-list'}}),
        device.createRenderPipelineAsync({label:'FLOAT third-res twenty-step volumetric scattering',layout:'auto',vertex:{module:volumeModule,entryPoint:'vs'},fragment:{module:volumeModule,entryPoint:'fsVolume',targets:[{format:'rgba16float'}]},primitive:{topology:'triangle-list'}}),
        device.createRenderPipelineAsync({label:'FLOAT full4K HDR reconstruction',layout:'auto',vertex:{module:compositeModule,entryPoint:'vs'},fragment:{module:compositeModule,entryPoint:'fsComposite',targets:[{format}]},primitive:{topology:'triangle-list'}}),
        textEnabled?device.createRenderPipelineAsync({label:'FLOAT dense scalar text radial scattering',layout:'auto',vertex:{module:textModule,entryPoint:'vs'},fragment:{module:textModule,entryPoint:'fsTextLight',targets:[{format:'rgba16float'}]},primitive:{topology:'triangle-list'}}):Promise.resolve(null),
        textEnabled?device.createRenderPipelineAsync({label:'FLOAT horizontal white-mask diffusion',layout:'auto',vertex:{module:maskModule,entryPoint:'vs'},fragment:{module:maskModule,entryPoint:'fsMaskHorizontal',targets:[{format:'rgba16float'}]},primitive:{topology:'triangle-list'}}):Promise.resolve(null),
        textEnabled?device.createRenderPipelineAsync({label:'FLOAT vertical scalar-mask diffusion',layout:'auto',vertex:{module:maskModule,entryPoint:'vs'},fragment:{module:maskModule,entryPoint:'fsMaskVertical',targets:[{format:'rgba16float'}]},primitive:{topology:'triangle-list'}}):Promise.resolve(null)
      ]);
      if (token !== generation) return stats();
      uniform = device.createBuffer({label:'FLOAT shared ambient and music-position frame',size:304,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      status.effectWidth=Math.max(1,Math.ceil(canvas.width*status.effectScale));
      status.effectHeight=Math.max(1,Math.ceil(canvas.height*status.effectScale));
      volumeTexture=device.createTexture({label:'FLOAT integrated underwater radiance',size:[status.effectWidth,status.effectHeight],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
      volumeView=volumeTexture.createView();
      status.textLightWidth=textEnabled?status.effectWidth:1;
      status.textLightHeight=textEnabled?status.effectHeight:1;
      textTexture=device.createTexture({label:textEnabled?'FLOAT live text scattering field':'FLOAT zero right-screen text field',size:[status.textLightWidth,status.textLightHeight],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
      textView=textTexture.createView();
      if(!textEnabled)device.queue.writeTexture({texture:textTexture},new Uint8Array(8),{bytesPerRow:8},[1,1]);
      glyphAlphaTexture=device.createTexture({label:textEnabled?'FLOAT opacity-independent projected foreground alpha':'FLOAT zero inactive foreground alpha',size:textEnabled?[status.effectWidth,status.effectHeight]:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
      glyphAlphaView=glyphAlphaTexture.createView();
      if(!textEnabled)device.queue.writeTexture({texture:glyphAlphaTexture},new Uint8Array(4),{bytesPerRow:4},[1,1]);
      const separateWave=combinedMode&&status.waveGodraysEnabled;
      combinedWaveTexture=device.createTexture({label:separateWave?'FLOAT combined projected wave alpha':'FLOAT zero separate wave alpha',size:separateWave?[status.effectWidth,status.effectHeight]:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
      combinedWaveView=combinedWaveTexture.createView();
      if(!separateWave)device.queue.writeTexture({texture:combinedWaveTexture},new Uint8Array(4),{bytesPerRow:4},[1,1]);
      if(textEnabled) {
        maskHorizontalTexture=device.createTexture({label:'FLOAT horizontally diffused glyph mask',size:[status.effectWidth,status.effectHeight],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
        maskVerticalTexture=device.createTexture({label:'FLOAT fully diffused glyph mask',size:[status.effectWidth,status.effectHeight],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
        maskHorizontalView=maskHorizontalTexture.createView();
        maskVerticalView=maskVerticalTexture.createView();
      }
      cookieTexture=device.createTexture({label:'FLOAT surface irradiance cookie',size:[512,512],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
      cookieView=cookieTexture.createView();
      densityTexture=noiseVolume();
      const noiseSampler=device.createSampler({addressModeU:'repeat',addressModeV:'repeat',addressModeW:'repeat',minFilter:'linear',magFilter:'linear'});
      const reconstructionSampler=device.createSampler({addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge',minFilter:'linear',magFilter:'linear'});
      if(opaqueMode&&!device.queue.copyExternalImageToTexture)throw new Error('Canvas-to-WebGPU image copy unavailable');
      baseTexture=device.createTexture({label:opaqueMode?'FLOAT full4K stage base':'FLOAT unused overlay base',size:opaqueMode?[canvas.width,canvas.height]:[1,1],format:'rgba8unorm-srgb',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
      status.baseTextureFormat=opaqueMode?'rgba8unorm-srgb':null;
      if(!opaqueMode)device.queue.writeTexture({texture:baseTexture},new Uint8Array([0,0,0,255]),{bytesPerRow:4},[1,1]);
      bindGroup = device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]});
      volumeUniformGroup=device.createBindGroup({layout:volumePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]});
      const densityView=densityTexture.createView({dimension:'3d'});
      cookieUniformGroup=device.createBindGroup({layout:cookiePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]});
      cookieGroup=device.createBindGroup({layout:cookiePipeline.getBindGroupLayout(1),entries:[{binding:0,resource:densityView},{binding:1,resource:noiseSampler}]});
      volumeGroup=device.createBindGroup({layout:volumePipeline.getBindGroupLayout(1),entries:[{binding:0,resource:densityView},{binding:1,resource:noiseSampler},{binding:2,resource:cookieView},{binding:3,resource:reconstructionSampler}]});
      const baseView=baseTexture.createView();
      if(textEnabled) {
        maskHorizontalUniform=device.createBindGroup({layout:maskHorizontalPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]});
        maskVerticalUniform=device.createBindGroup({layout:maskVerticalPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]});
        maskHorizontalSource=device.createBindGroup({layout:maskHorizontalPipeline.getBindGroupLayout(1),entries:[{binding:0,resource:glyphAlphaView},{binding:1,resource:reconstructionSampler},{binding:2,resource:combinedWaveView}]});
        maskVerticalSource=device.createBindGroup({layout:maskVerticalPipeline.getBindGroupLayout(1),entries:[{binding:0,resource:maskHorizontalView},{binding:1,resource:reconstructionSampler}]});
        textUniformGroup=device.createBindGroup({layout:textPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]});
        textSourceGroup=device.createBindGroup({layout:textPipeline.getBindGroupLayout(1),entries:[{binding:0,resource:maskVerticalView},{binding:1,resource:reconstructionSampler}]});
      }
      const waveForegroundView=combinedMode?combinedWaveView:glyphAlphaView;
      const composedGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[{binding:0,resource:volumeView},{binding:1,resource:reconstructionSampler},{binding:2,resource:baseView},{binding:3,resource:reconstructionSampler},{binding:4,resource:textView},{binding:5,resource:reconstructionSampler},{binding:6,resource:waveForegroundView},{binding:7,resource:reconstructionSampler}]});
      bindGroup={uniform:bindGroup,field:composedGroup};
      createTiming();
      status.ready = true;
      canvas.style.visibility = 'visible';
      return stats();
    } catch (error) {
      if (token === generation) hide(error.message || String(error));
      if(opaqueMode&&token===generation) {
        // Initialization fallback must wait until init's pending promise clears.
        opaqueFallbackReason=error.message||String(error);
        opaqueMode=false;
        status.baseCopyError=opaqueFallbackReason;
        status.compositionMode='overlay-fallback-pending';
        setTimeout(()=>void init({...config,opaqueComposite:false}),0);
      }
      return stats();
    }
  }
  function init(nextConfig = window.stage?.config || {}) {
    if (pending) return pending;
    pending = initialize(nextConfig).finally(() => { pending = null; });
    return pending;
  }
  function update(frame = {}) {
    if (!status.ready || !device || document.hidden) return false;
    try {
      const submittedAt=performance.now();
      if(opaqueMode) {
        try {
          if(stageCanvas.width!==canvas.width||stageCanvas.height!==canvas.height)throw new Error('Base canvas must retain the same fixed4K dimensions');
          const copyAt=performance.now();
          device.queue.copyExternalImageToTexture({source:stageCanvas,flipY:false},{texture:baseTexture,colorSpace:status.gamut,premultipliedAlpha:false},[canvas.width,canvas.height]);
          status.baseCopyCpuMs=performance.now()-copyAt;
        } catch(error) { fallbackOpaque(error);return false; }
      }
      if(textEnabled) {
        status.textMaskReady=false;
        status.waveMaskReady=false;
        status.textMaskError=null;
        status.waveMaskError=null;
        const primaryAllowed=status.foregroundRayRole==='waveform'?status.waveGodraysEnabled:status.textGodraysEnabled;
        const sources=[{enabled:primaryAllowed,mask:frame.textMaskCanvas,texture:glyphAlphaTexture,prefix:'text'},
          {enabled:combinedMode&&status.waveGodraysEnabled,mask:frame.waveMaskCanvas,texture:combinedWaveTexture,prefix:'wave'}];
        for(const {enabled,mask,texture,prefix} of sources)if(enabled&&mask) {
          try {
            if(mask.width!==status.effectWidth||mask.height!==status.effectHeight)throw new Error(`Projected mask dimensions ${mask.width}x${mask.height} must match ${status.effectWidth}x${status.effectHeight}`);
            const copyAt=performance.now();
            device.queue.copyExternalImageToTexture({source:mask,flipY:false},{texture,colorSpace:status.gamut,premultipliedAlpha:false},[status.effectWidth,status.effectHeight]);
            status[prefix+'MaskCopyCpuMs']=performance.now()-copyAt;
            status[prefix+'MaskReady']=true;
            status[prefix+'MaskWidth']=mask.width;
            status[prefix+'MaskHeight']=mask.height;
            status[prefix+'MaskFrames']++;
          } catch(error) { status[prefix+'MaskError']=error.message||String(error); }
        }
        if(!combinedMode&&status.foregroundRayRole==='waveform') {
          status.waveMaskReady=status.textMaskReady;
          status.waveMaskWidth=status.textMaskWidth;
          status.waveMaskHeight=status.textMaskHeight;
          status.waveMaskFrames=status.textMaskFrames;
          status.waveMaskCopyCpuMs=status.textMaskCopyCpuMs;
          status.waveMaskError=status.textMaskError;
        }
      }
      const foregroundReady=status.textMaskReady||status.waveMaskReady;
      status.renderPasses=textEnabled?(foregroundReady?6:4):3;
      if(lastUpdate)status.frameIntervalMs=status.frameIntervalMs?status.frameIntervalMs*.92+(submittedAt-lastUpdate)*.08:submittedAt-lastUpdate;
      lastUpdate=submittedAt;
      const hues = Array.isArray(frame.hues) || ArrayBuffer.isView(frame.hues) ? frame.hues : [194,211,178];
      pointer.x += (clamp(finite(frame.pointer?.x,0.5),0,1)-pointer.x)*0.04;
      pointer.y += (clamp(finite(frame.pointer?.y,0.5),0,1)-pointer.y)*0.04;
      values.set([canvas.width,canvas.height,finite(frame.time,0)%86400,clamp(finite(frame.energy,0),0,1),
        ((finite(hues[0],194)%360)+360)%360/360,((finite(hues[1],211)%360)+360)%360/360,((finite(hues[2],178)%360)+360)%360/360,status.hdr?1:0,
        pointer.x,pointer.y,(frame.role||config.role)==='combined'?2:(frame.role||config.role)==='waveform'?1:0,status.hdr?1:0.8,
        status.effectWidth,status.effectHeight,status.integrationSteps,opaqueMode?1:0]);
      const requestedRayTime=Math.max(0,finite(frame.rayMotionTime,finite(frame.time,0)));
      const positionTime=frame.isPlaying===false&&lastRayMotionTime!==null?lastRayMotionTime:requestedRayTime;
      lastRayMotionTime=positionTime;
      status.rayMotionTime=positionTime;
      status.musicMotionSpeed=frame.isPlaying===false?0:Math.max(0,finite(frame.musicMotionSpeed,finite(frame.rayMotionSpeed,0)));
      status.rayMotionPaused=frame.isPlaying===false;
      updateLightPools(finite(frame.time,0)%86400,positionTime);
      updatePalette(hues);
      values[43]=status.textMaskReady?1:0;
      values.set([positionTime,status.musicMotionSpeed,status.rayMotionPaused?1:0,status.waveMaskReady?1:0],72);
      device.queue.writeBuffer(uniform,0,values);
      const measure=timing&&!timing.busy&&status.frames%60===0?timing:null;
      const encoder = device.createCommandEncoder({label:'FLOAT HDR frame'});
      const cookiePass=encoder.beginRenderPass({label:'FLOAT surface refraction cookie',timestampWrites:measure?{querySet:measure.querySet,beginningOfPassWriteIndex:0}:undefined,colorAttachments:[{view:cookieView,clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});
      cookiePass.setPipeline(cookiePipeline);
      cookiePass.setBindGroup(0,cookieUniformGroup);
      cookiePass.setBindGroup(1,cookieGroup);
      cookiePass.draw(3);
      cookiePass.end();
      const volumePass=encoder.beginRenderPass({label:'FLOAT underwater integration',colorAttachments:[{view:volumeView,clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});
      volumePass.setPipeline(volumePipeline);
      volumePass.setBindGroup(0,volumeUniformGroup);
      volumePass.setBindGroup(1,volumeGroup);
      volumePass.draw(3);
      volumePass.end();
      if(textEnabled&&foregroundReady) {
        const horizontalPass=encoder.beginRenderPass({label:'FLOAT glyph-mask horizontal diffusion',colorAttachments:[{view:maskHorizontalView,clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});
        horizontalPass.setPipeline(maskHorizontalPipeline);
        horizontalPass.setBindGroup(0,maskHorizontalUniform);
        horizontalPass.setBindGroup(1,maskHorizontalSource);
        horizontalPass.draw(3);
        horizontalPass.end();
        const verticalPass=encoder.beginRenderPass({label:'FLOAT glyph-mask vertical diffusion',colorAttachments:[{view:maskVerticalView,clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});
        verticalPass.setPipeline(maskVerticalPipeline);
        verticalPass.setBindGroup(0,maskVerticalUniform);
        verticalPass.setBindGroup(1,maskVerticalSource);
        verticalPass.draw(3);
        verticalPass.end();
        const textPass=encoder.beginRenderPass({label:'FLOAT letter light and occlusion',colorAttachments:[{view:textView,clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});
        textPass.setPipeline(textPipeline);
        textPass.setBindGroup(0,textUniformGroup);
        textPass.setBindGroup(1,textSourceGroup);
        textPass.draw(3);
        textPass.end();
      } else if(textEnabled) {
        // Never reuse stale illumination when a mask is missing/invalid.
        const clearText=encoder.beginRenderPass({label:'FLOAT clear unavailable glyph light',colorAttachments:[{view:textView,clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});
        clearText.end();
      }
      const pass = encoder.beginRenderPass({label:'FLOAT full4K HDR reconstruction',timestampWrites:measure?{querySet:measure.querySet,endOfPassWriteIndex:1}:undefined,colorAttachments:[{view:context.getCurrentTexture().createView(),clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});
      pass.setPipeline(pipeline);
      pass.setBindGroup(0,bindGroup.uniform);
      pass.setBindGroup(1,bindGroup.field);
      pass.draw(3);
      pass.end();
      if(measure) {
        encoder.resolveQuerySet(measure.querySet,0,2,measure.resolveBuffer,0);
        encoder.copyBufferToBuffer(measure.resolveBuffer,0,measure.readBuffer,0,16);
      }
      device.queue.submit([encoder.finish()]);
      if(opaqueMode) {
        // opacity preserves layout, canvas drawing and all existing hit tests.
        stageCanvas.style.opacity='0';
        status.compositionMode='opaque';
      }
      status.frames++;
      if(measure)void readTiming(measure,status.frames);
      status.cpuSubmitMs=performance.now()-submittedAt;
      return true;
    } catch (error) { hide(error.message || String(error)); return false; }
  }
  function destroy() {
    generation++;
    hide(null);
    context?.unconfigure();
    releaseFields();
  }
  window.StageHDR = Object.freeze({init,update,stats,destroy});
  // A display/Windows HDR switch changes capability without making a second RAF.
  try {
    matchMedia('(dynamic-range: high)').addEventListener('change', () => {
      if (canvas && !pending) void init(config);
    });
  } catch { /* Old media-query implementations simply retain SDR. */ }
})();
