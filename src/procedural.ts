import * as THREE from 'three';

/**
 * Procedural idle / walk / run for humanoid rigs that ship without animation clips
 * (Mixamo, Ready Player Me, most Sketchfab exports). Bones are found by their standard
 * names. Limbs are *aimed* at target directions in the character's own frame
 * (+Y up, +Z forward), so the result doesn't depend on the rig's rest pose (T-pose,
 * A-pose, pre-bent elbows…) or on how each bone's local axes are set up.
 */

const NAMES = [
  'Spine', 'Spine1', 'Head',
  'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot',
] as const;
type Name = (typeof NAMES)[number];

// "LeftArm", "mixamorig:LeftArm", "mixamorigLeftArm", "LeftArm_013" — but not "LeftForeArm1_015".
const matcher = (n: string) => new RegExp(`^(?:mixamorig:?)?${n}(?:_\\d+)?$`);

export function findHumanoidBone(root: THREE.Object3D, name: string): THREE.Object3D | undefined {
  const re = matcher(name);
  let hit: THREE.Object3D | undefined;
  root.traverse((o) => {
    if (!hit && re.test(o.name)) hit = o;
  });
  return hit;
}

const RAD = Math.PI / 180;
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const ARM_OUT = 13 * RAD; // relaxed arms hang slightly away from the body

export class ProceduralRig {
  private b: Partial<Record<Name, THREE.Object3D>> = {};
  private rest = new Map<THREE.Object3D, THREE.Quaternion>();
  private thighRest = { left: new THREE.Vector3(0, -1, 0), right: new THREE.Vector3(0, -1, 0) };
  private legLength = 0.9;
  private phase = 0;
  private t = Math.random() * 10; // desync idle breathing between players
  private speed = 0;

  // scratch
  private qRoot = new THREE.Quaternion(); // inverse of the root's world rotation
  private qP = new THREE.Quaternion();
  private qD = new THREE.Quaternion();
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private tUpper = new THREE.Vector3();
  private tLower = new THREE.Vector3();

  /** `root` must face +Z with feet at y=0 (see assets.ts normalise). Null if it's not a humanoid. */
  static create(root: THREE.Object3D): ProceduralRig | null {
    const rig = new ProceduralRig(root);
    const b = rig.b;
    const ok = (['LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand',
      'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'] as Name[]).every((n) => b[n]);
    return ok ? rig : null;
  }

  private constructor(private root: THREE.Object3D) {
    for (const n of NAMES) {
      const bone = findHumanoidBone(root, n);
      if (bone) {
        this.b[n] = bone;
        this.rest.set(bone, bone.quaternion.clone());
      }
    }
    root.updateWorldMatrix(true, true);
    this.root.getWorldQuaternion(this.qRoot).invert();
    const { LeftUpLeg, LeftLeg, RightUpLeg, RightLeg } = this.b;
    if (LeftUpLeg && LeftLeg) this.thighRest.left.copy(this.dir(LeftUpLeg, LeftLeg));
    if (RightUpLeg && RightLeg) this.thighRest.right.copy(this.dir(RightUpLeg, RightLeg));
    if (LeftUpLeg) this.legLength = Math.max(0.3, root.worldToLocal(LeftUpLeg.getWorldPosition(this.v1)).y);
  }

  /** Unit direction bone → tip in the character frame (world matrices must be current). */
  private dir(bone: THREE.Object3D, tip: THREE.Object3D): THREE.Vector3 {
    const a = bone.getWorldPosition(this.v1);
    return tip.getWorldPosition(this.v2).sub(a).applyQuaternion(this.qRoot).normalize();
  }

  /** Rotate `bone` by `D` (a rotation in the character frame) on top of its rest pose. */
  private pose(bone: THREE.Object3D | undefined, D: THREE.Quaternion) {
    if (!bone?.parent) return;
    bone.parent.updateWorldMatrix(true, false);
    const P = bone.parent.getWorldQuaternion(this.qP).premultiply(this.qRoot); // parent, character frame
    bone.quaternion.copy(P).invert().multiply(D).multiply(P).multiply(this.rest.get(bone)!); // P⁻¹·D·P·rest
  }

  /** Point `bone` so that the segment bone → tip runs along `target` (unit, character frame). */
  private aim(bone: THREE.Object3D | undefined, tip: THREE.Object3D | undefined, target: THREE.Vector3) {
    if (!bone || !tip) return;
    bone.quaternion.copy(this.rest.get(bone)!);
    tip.updateWorldMatrix(true, false);
    this.pose(bone, this.qD.setFromUnitVectors(this.dir(bone, tip), target));
  }

  update(dt: number, speed: number) {
    this.t += dt;
    this.speed += (speed - this.speed) * Math.min(1, dt * 8);
    const s = this.speed;
    const walk = THREE.MathUtils.clamp(s / 3, 0, 1); // 0 = idle … 1 = full stride
    const run = THREE.MathUtils.clamp((s - 4.5) / 2.5, 0, 1);
    this.phase += dt * 2 * Math.PI * (0.55 + 0.27 * s); // step rate rises with speed

    const ph = this.phase;
    const breathe = Math.sin(this.t * 2 * Math.PI * 0.25);
    const hipA = (28 + 17 * run) * RAD * walk;
    const kneeA = (45 + 45 * run) * RAD * walk;
    const armA = (18 + 22 * run) * RAD * walk;
    const elbow = (8 + 10 * walk + 42 * run) * RAD;

    this.root.updateWorldMatrix(true, false);
    this.root.getWorldQuaternion(this.qRoot).invert();

    // Torso first (top-down), so the limbs below see its new orientation.
    const b = this.b;
    this.pose(b.Spine, this.qD.setFromAxisAngle(X, (3 * walk + 9 * run) * RAD + breathe * 1.2 * RAD));
    this.pose(b.Spine1, this.qD.setFromAxisAngle(Y, -6 * RAD * walk * Math.sin(ph)));
    this.pose(b.Head, this.qD.setFromAxisAngle(X, -(2 * walk + 6 * run) * RAD)); // eyes level when leaning

    for (const side of ['left', 'right'] as const) {
      const L = side === 'left';
      const sx = L ? 1 : -1; // +X is the character's left
      const p = ph + (L ? 0 : Math.PI);
      const sway = 1.5 * RAD * Math.sin(this.t * 1.3 + (L ? 0 : 2));

      // Arm hangs down and a little out, swinging opposite to the same-side leg.
      this.tUpper.set(sx * Math.sin(ARM_OUT), -Math.cos(ARM_OUT), 0).applyAxisAngle(X, armA * Math.sin(p) + sway);
      this.aim(L ? b.LeftArm : b.RightArm, L ? b.LeftForeArm : b.RightForeArm, this.tUpper);
      // Elbow bends the forearm forward from the upper arm.
      this.tLower.copy(this.tUpper).applyAxisAngle(X, -elbow);
      this.aim(L ? b.LeftForeArm : b.RightForeArm, L ? b.LeftHand : b.RightHand, this.tLower);

      // Thigh swings about the hip (+ = forward); the knee bends while the leg swings through.
      this.tUpper.copy(this.thighRest[side]).applyAxisAngle(X, -hipA * Math.sin(p));
      this.aim(L ? b.LeftUpLeg : b.RightUpLeg, L ? b.LeftLeg : b.RightLeg, this.tUpper);
      this.tLower.copy(this.tUpper).applyAxisAngle(X, kneeA * Math.max(0, Math.cos(p)) + 4 * RAD * walk);
      this.aim(L ? b.LeftLeg : b.RightLeg, L ? b.LeftFoot : b.RightFoot, this.tLower);
    }

    // Swinging the legs lifts the feet; lower the body so the planted foot stays on the ground.
    const reach = Math.abs(Math.sin(ph)) * hipA;
    this.root.position.y = -this.legLength * (1 - Math.cos(reach)) + 0.015 * walk * Math.cos(2 * ph);
  }
}
