import { Canvas, useFrame } from '@react-three/fiber';
import { useReducedMotion } from 'framer-motion';
import { Suspense, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { PIPELINE } from './product';
import { cx } from '../lib/util';

/* ==========================================================================
   The hero field
   --------------------------------------------------------------------------
   useink.xyz gets its motion from a rendered 3D glass object turning slowly in
   front of a graded backdrop. A video file cannot do that here: it would be a
   recording of someone else's scene, frozen at one angle, and the brief says not
   to ship invented artefacts. So this is the real thing: a few faceted prisms
   with physical transmission, drifting, catching one cool key light.

   Three honest constraints:

   · It is ARI's palette, not the reference's. Steel blue accent on near-black, no
     violet, no rainbow iridescence. `iridescence` is at 0.22 and only tilts the
     edge colour; it is not a soap bubble.
   · `prefers-reduced-motion` renders one still frame. The scene is composed, not
     removed, so the hero does not collapse into an empty box.
   · No WebGL, or a blocked context, and the region falls back to the pipeline rail
     set in type. Nothing is faked at any point.
   ========================================================================== */

const PRISMS: readonly { x: number; y: number; z: number; s: number; seed: number; glass: boolean }[] = [
  { x: 0.0, y: 0.15, z: 0.0, s: 1.16, seed: 0.0, glass: true },
  { x: -1.42, y: -0.62, z: -0.7, s: 0.62, seed: 1.7, glass: false },
  { x: 1.36, y: 0.72, z: -0.9, s: 0.72, seed: 3.1, glass: true },
  { x: 1.02, y: -0.98, z: 0.25, s: 0.44, seed: 4.4, glass: false },
  { x: -1.06, y: 1.06, z: -0.35, s: 0.5, seed: 5.6, glass: true },
  { x: -0.24, y: -1.34, z: -1.2, s: 0.86, seed: 2.3, glass: false },
];

function Prism({ prism, still }: { readonly prism: (typeof PRISMS)[number]; readonly still: boolean }) {
  const mesh = useRef<THREE.Mesh>(null);
  const geometry = useMemo(() => new THREE.IcosahedronGeometry(prism.s, 0), [prism.s]);
  const edges = useMemo(() => new THREE.EdgesGeometry(geometry), [geometry]);

  useFrame((state) => {
    if (still || mesh.current === null) return;
    const t = state.clock.elapsedTime;
    mesh.current.rotation.y = t * 0.055 + prism.seed;
    mesh.current.rotation.x = Math.sin(t * 0.09 + prism.seed) * 0.22 + 0.34;
    mesh.current.position.y = prism.y + Math.sin(t * 0.24 + prism.seed) * 0.055;
  });

  return (
    <mesh ref={mesh} geometry={geometry} position={[prism.x, prism.y, prism.z]} rotation={[0.34, prism.seed, 0]}>
      {prism.glass ? (
        <meshPhysicalMaterial
          color={new THREE.Color('#a9c9e6')}
          metalness={0}
          roughness={0.14}
          transmission={0.92}
          thickness={0.9}
          ior={1.55}
          iridescence={0.22}
          iridescenceIOR={1.3}
          attenuationColor={new THREE.Color('#2b4d6e')}
          attenuationDistance={2.6}
        />
      ) : (
        <meshStandardMaterial color={new THREE.Color('#1b222b')} metalness={0.6} roughness={0.45} flatShading />
      )}
      <lineSegments geometry={edges}>
        <lineBasicMaterial color={new THREE.Color(prism.glass ? '#4d6d8c' : '#232830')} transparent opacity={0.55} />
      </lineSegments>
    </mesh>
  );
}

function Rig({ still }: { readonly still: boolean }) {
  const group = useRef<THREE.Group>(null);

  /**
   * Parallax reads `state.pointer`, which R3F keeps normalised across the canvas, rather than a
   * window listener: a listener on the page would move a hero the pointer is nowhere near.
   */
  useFrame((state) => {
    if (group.current === null) return;
    const px = still ? 0 : state.pointer.x;
    const py = still ? 0 : -state.pointer.y;
    group.current.rotation.y += (px * 0.2 - group.current.rotation.y) * 0.05;
    group.current.rotation.x += (py * 0.12 - group.current.rotation.x) * 0.05;
    if (still) return;
    group.current.position.y = Math.sin(state.clock.elapsedTime * 0.2) * 0.02;
  });

  return (
    <group ref={group}>
      {PRISMS.map((prism) => (
        <Prism key={`${prism.x}:${prism.y}`} prism={prism} still={still} />
      ))}
    </group>
  );
}

function Backdrop() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `
          varying vec2 vUv;
          void main() {
            vec2 p = vUv - 0.5;
            float r = length(p) * 1.42;
            vec3 deep = vec3(0.024, 0.028, 0.035);
            vec3 mid  = vec3(0.055, 0.072, 0.098);
            vec3 lift = vec3(0.135, 0.185, 0.250);
            vec3 col = mix(mid, deep, smoothstep(0.05, 0.95, r));
            col = mix(col, lift, smoothstep(0.42, 0.0, distance(vUv, vec2(0.66, 0.62))) * 0.55);
            gl_FragColor = vec4(col, 1.0);
          }
        `,
        depthWrite: false,
      }),
    [],
  );
  return <mesh position={[0, 0, -3]} material={material} scale={[9, 6, 1]}><planeGeometry /></mesh>;
}

/** One probe, so a machine without a context never mounts a Canvas to fail inside it. */
function webglAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.__ariWebgl !== undefined) return window.__ariWebgl;
  let ok = false;
  try {
    const canvas = document.createElement('canvas');
    ok = canvas.getContext('webgl2') !== null || canvas.getContext('webgl') !== null;
  } catch {
    ok = false;
  }
  window.__ariWebgl = ok;
  return ok;
}

declare global {
  interface Window {
    __ariWebgl?: boolean | undefined;
  }
}

export function GlassField({ className }: { readonly className?: string }) {
  const reduce = useReducedMotion();
  const [contextLost, setContextLost] = useState(false);
  const still = reduce === true;
  const supported = !contextLost && webglAvailable();

  return (
    <div className={cx('relative overflow-hidden bg-sunken', className)} aria-hidden="true">
      {supported ? (
        <Canvas
          dpr={[1, 1.6]}
          frameloop={still ? 'demand' : 'always'}
          camera={{ position: [0, 0, 4.2], fov: 34 }}
          gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
          onCreated={(state) => {
            state.gl.setClearAlpha(0);
            state.gl.domElement.addEventListener('webglcontextlost', () => setContextLost(true));
          }}
        >
          <ambientLight intensity={0.75} />
          <directionalLight position={[3.2, 4, 2.6]} intensity={3.4} color={new THREE.Color('#dbe8f6')} />
          <directionalLight position={[-3.4, -1.6, -2.2]} intensity={1.5} color={new THREE.Color('#6f9ec8')} />
          <Suspense fallback={null}>
            <Backdrop />
            <Rig still={still} />
          </Suspense>
        </Canvas>
      ) : (
        <TypographicField />
      )}
    </div>
  );
}

/** The no-WebGL state: the same seven stages, set in the display face. */
function TypographicField() {
  return (
    <div className="flex h-full min-h-[16rem] flex-col justify-end gap-1 p-6">
      {PIPELINE.map((step, index) => (
        <span key={step} className="flex items-baseline gap-3">
          <span className="font-mono text-[11px] text-ink-4">{String(index + 1).padStart(2, '0')}</span>
          <span className="display text-lg text-ink-2">{step}</span>
        </span>
      ))}
    </div>
  );
}

