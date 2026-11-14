// All characters drawn with one InstancedMesh per body part on a jointed rig: upper arms, forearms,
// thighs and shins hinge at the elbows and knees, feet are planted by the gait (render/gait.ts), and the
// trunk and the weapon in hand come from sim/pose.ts, the pose the simulation shoots from. Drivers and
// passengers are drawn in their seats.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, damp, lerp, wrapAngle } from '../core/math';
import type { Character, Vehicle } from '../sim/entities';
import { isWoman } from '../sim/appearance';
import { cowerHandsUp } from '../sim/peds';
import {
  aimed, aimFrame, anchor, hipSpread, makeTrunk, makeWeaponPose, SKELETON, trunkPose, weaponPoint, weaponPoseInto,
  SWIM_HIP, SWIM_TREAD_LEAN, WEAPON_POINTS, seatSide, windowMuzzle, type Trunk, type WeaponPose,
} from '../sim/pose';
import { isGun, type VehicleKind, type WeaponId } from '../sim/specs';
import { BARE_ARM, BARE_LEG, characterGeometries, DRAWN_SHOULDER, WOMAN, type CharacterPartName } from './characterGeometry';
import { PAINT, paintShader } from './characterPaint';
import { gait, makeGaitOut, makeTwoBone, soleLow, solveLeg, solveTwoBone, type GaitStyle, type LegPose } from './gait';
import { onDrawn, riderMount } from './riders';
import { seaHeightAt, type SeaWaveUniforms } from './sea';
import { cabinLayout, drawnFrame, riderSeat, VehicleView, type RiderSeat } from './vehicleView';
import { GUN_IDS, gunGeometry } from './weaponModels';

const MAX = 240;
/**
 * The flinch of someone hit: how long the sim keeps him hurt (CombatSystem.damageCharacter sets Character.hurtTimer to
 * this), and how far his trunk snaps back (rad), twists to one side (rad) and sinks (m, at a height of 1) at the hit.
 */
const HURT_TIME = 0.35;
/** Someone standing idle: how far his chest leans with a breath and turns as he shifts (rad), and how far he looks round. */
const IDLE_BREATH = 0.012;
const IDLE_SWAY = 0.025;
const IDLE_GLANCE = 0.3;
/** How fast that comes and goes as he stops and sets off (1/s). */
const IDLE_EASE = 5;
/**
 * The highest a foot is lifted stepping into or out of his stance (m, height 1), and the rate the gait comes or goes
 * (1/s) below which the step is over.
 */
const STEP_LIFT = 0.08;
const STEP_SETTLED = 0.05;
/** How fast the stance and the lean into turns come back after he puts a gun away (1/s). */
const LOOSE_EASE = 10;
/**
 * Turning, he leads with his head and chest and leans into the turn: per rad/s of the turn, the head's and the chest's
 * lead (rad) and the lean (rad, per m/s of his speed), and the most of each. A heading slews at 9 to 16 rad/s, so a
 * walker rounding a corner looks 0.36 rad into it before his hips come round, and a sprinter cutting one leans 8
 * degrees.
 */
const TURN_HEAD = 0.04;
const TURN_HEAD_MAX = 0.45;
const TURN_CHEST = 0.02;
const TURN_CHEST_MAX = 0.2;
const TURN_BANK = 0.004;
const TURN_BANK_MAX = 0.14;
/** How fast the drawn turn follows the heading's rate (1/s): smooth over a frame's jitter, quick enough to lead. */
const TURN_EASE = 14;
const FLINCH_LEAN = 0.34;
const FLINCH_TWIST = 0.24;
const FLINCH_DROP = 0.06;
/** Seated drivers and passengers are drawn within this distance of the camera. */
export const OCCUPANT_RANGE = 60;
/**
 * The driver's hands turn this far round the wheel at full lock (rad, clockwise for a right turn), which keeps the lower
 * hand above the cabin floor (the wheel's centre sits 0.1 m above it).
 */
const WHEEL_LOCK = 0.5;

type Gun = Exclude<WeaponId, 'fists'>;
/**
 * Recoil kick (rad) of each weapon just after a shot; it is drawn only, never part of the muzzle. The frame a shot is
 * fired on shows the gun as the shot left it, the flash and tracer on its barrel end; the kick comes in from the next.
 */
export const KICK: Readonly<Partial<Record<Gun, number>>> = { pistol: 0.12, smg: 0.06, shotgun: 0.3, rifle: 0.1, rocket: 0.15, sniper: 0.2 };
/** The kick of a weapon with no entry in KICK. */
const DEFAULT_KICK = 0.1;
const gunKick = (gun: Gun): number => KICK[gun] ?? DEFAULT_KICK;
/** The kick is at full strength while shotTimer is above this, then dies away with it. */
const KICK_HOLD = 0.05;
const KICK_BACK = 0.05;

/**
 * Characters dissolve right in front of the camera, by depth along the view (m): nothing nearer than LENS_FADE_GONE is
 * drawn, and they are whole again from LENS_FADE_FULL. The near plane (0.3 m) then never cuts one open into a hollow
 * shell, whether a wall has pulled the camera in to the player's head or a passer-by brushes the lens.
 */
export const LENS_FADE_GONE = 0.45;
/** How much lighter cloth and skin are drawn at a grazing angle (fadeNearLens). */
const NAP = 0.14;
export const LENS_FADE_FULL = 0.9;

/**
 * Makes a character material dissolve near the lens (LENS_FADE_GONE .. LENS_FADE_FULL of depth) through a 4x4 Bayer
 * dither, like the foliage near the camera (props.ts) but by depth, the near plane's own measure. Opaque, so no sorting
 * and no extra draws; shadows come from the default depth material, so a faded player keeps his.
 */
function fadeNearLens(shader: THREE.WebGLProgramParametersWithUniforms): void {
  fadeByInstance(shader);
  // Cloth and skin are a little lighter where they turn away from the eye, as a nap catches the light: a dark jacket
  // keeps its form against a dark street instead of reading as a cut-out. Lit like the rest of it, so it does not glow.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <normal_fragment_maps>',
    `#include <normal_fragment_maps>
{
  float nap = pow( 1.0 - saturate( dot( normalize( vViewPosition ), normal ) ), 2.5 );
  diffuseColor.rgb += nap * ${NAP.toFixed(2)} * ( vec3( 0.3 ) + diffuseColor.rgb );
}`,
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <clipping_planes_fragment>',
    `#include <clipping_planes_fragment>
if ( vViewPosition.z < ${LENS_FADE_FULL.toFixed(2)} && lensBayer4( gl_FragCoord.xy ) >= smoothstep( ${LENS_FADE_GONE.toFixed(2)}, ${LENS_FADE_FULL.toFixed(2)}, vViewPosition.z ) ) discard;`,
  );
}

/**
 * A character fading in (just come into view) or out (just removed): each instance's `instanceFade` (0..1) keeps that
 * share of its pixels through the same 4x4 Bayer dither, so a fade needs no transparency, sorting or extra draw, and
 * every tier draws it with the program it already has.
 */
function fadeByInstance(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float instanceFade;\nvarying float vInstanceFade;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstanceFade = instanceFade;');
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
varying float vInstanceFade;
float lensBayer4( vec2 frag ) {
  const float m[ 16 ] = float[ 16 ]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
  ivec2 p = ivec2( mod( floor( frag ), 4.0 ) );
  return ( m[ p.x + p.y * 4 ] + 0.5 ) / 16.0;
}`,
    )
    .replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>
if ( vInstanceFade < 1.0 && lensBayer4( gl_FragCoord.xy ) >= vInstanceFade ) discard;`,
    );
}

/**
 * A part with two shapes (the torso and the hips: characterGeometry's `positionB`, `normalB`): each instance is drawn
 * `instanceShape` of the way from the first to the second, so a man and a woman come out of the same batch.
 */
function shapeByInstance(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float instanceShape;\nattribute vec3 positionB;\nattribute vec3 normalB;')
    .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = mix( objectNormal, normalB, instanceShape );')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = mix( transformed, positionB, instanceShape );');
}

/**
 * The hands, one geometry for both: the right one is drawn mirrored (a negative scale across), which turns its faces
 * inside out to the rasteriser. Drawn from both sides, a mirrored instance's faces count as its front, its normals
 * the right way out (three's instanced normal transform mirrors them with the hand).
 */
function mirroredHand(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vMirror;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMirror = sign( determinant( mat3( instanceMatrix ) ) );');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vMirror;')
    .replace(
      '#include <normal_fragment_begin>',
      THREE.ShaderChunk.normal_fragment_begin.replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = ( gl_FrontFacing ? 1.0 : - 1.0 ) * vMirror;'),
    );
}

/**
 * The characters' shadow: three's depth material with the same per-instance fade (dithered in the shadow map), and no
 * lens fade, so a player dissolved by the camera keeps his shadow. `shaped`: for a part with two shapes.
 */
function characterDepthMaterial(shaped = false): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = shaped
    ? (shader) => {
        fadeByInstance(shader);
        shapeByInstance(shader);
      }
    : fadeByInstance;
  return m;
}

/** A character coming into view fades in over this long (s); one removed in view fades out over PED_FADE_OUT. */
export const PED_FADE_IN = 0.5;
export const PED_FADE_OUT = 0.6;

const FIRST_DRAWN_LOG = 400;

/** Per character drawn: its fade (0..1), whether it is fading out after removal, and the frame it was last drawn. */
interface Fade {
  f: number;
  out: boolean;
  frame: number;
  /** Last drawn on foot (a rider removed with his car does not linger). */
  foot: boolean;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

function mergeAll(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(gs.map((g) => g.toNonIndexed()), false);
  if (!m) throw new Error('merge failed');
  return m;
}

interface Part {
  mesh: THREE.InstancedMesh;
  n: number;
  /** For a part with two shapes: each instance's share of the second (see shapeByInstance). */
  shape?: Float32Array;
  /** For a painted part (characterPaint): each instance's second colour (linear rgb) and style. */
  trim?: Float32Array;
  style?: Float32Array;
}

type PartName = CharacterPartName;

/** Per-character smoothing between poses. */
interface Anim {
  /** 0 upright .. 1 lying (knocked down or dead). */
  lie: number;
  /** 0 standing .. 1 stepping with the gait. */
  walk: number;
  /** 0 on the ground .. 1 airborne (knees tucked). */
  air: number;
  /** 0 .. 1: how far he has settled into standing about (the breath, the sway and the glance come and go with it). */
  ease: number;
  /** Frame the character was last drawn. */
  frame: number;
  /** His heading as last drawn, and the rate it turns at (rad/s, smoothed). */
  yaw: number;
  turn: number;
  /** How fast `walk` is changing (1/s): setting off or stopping, not a steady crawl. */
  shift: number;
  /** The foot stepping into or out of his stance (0 left, 1 right), -1 between steps. */
  stepper: number;
  /**
   * 0 .. 1: how far what the renderer adds to his trunk (the stance, the lean into a turn, his carriage) is drawn. Off at
   * once when he takes a gun in hand (it is held where the simulation has his chest), back over a few frames after.
   */
  loose: number;
}

type P3 = { readonly x: number; readonly y: number; readonly z: number };

// Scratch objects: one character is posed at a time, and each object has one job.
const V = () => new THREE.Vector3();
const S = {
  /** Instance matrix being written. */
  inst: new THREE.Matrix4(),
  /** Body frame rotation of the character being posed (chest, lying or seat frame). */
  body: new THREE.Matrix4(),
  /** Vehicle body frame and its rotation (seated characters). */
  frame: new THREE.Matrix4(),
  vrot: new THREE.Matrix4(),
  /** Temporary rotations inside helpers. */
  rot: new THREE.Matrix4(),
  rot2: new THREE.Matrix4(),
  /** Drawn weapon matrix. */
  weapon: new THREE.Matrix4(),
  q: new THREE.Quaternion(),
  e: new THREE.Euler(0, 0, 0, 'YXZ'),
  sc: V(),
  // Joints of the character being posed.
  pelvis: V(),
  neck: V(),
  hipL: V(),
  hipR: V(),
  shL: V(),
  shR: V(),
  knee: V(),
  ankle: V(),
  elbow: V(),
  hand: V(),
  wrist: V(),
  // Axes: body frame, hips, vehicle.
  left: V(),
  up: V(),
  fwd: V(),
  hipLeft: V(),
  vleft: V(),
  vup: V(),
  vfwd: V(),
  // Arm targets and IK pole.
  targetL: V(),
  targetR: V(),
  pole: V(),
  // Limb directions and bone basis.
  d1: V(),
  d2: V(),
  bx: V(),
  by: V(),
  bz: V(),
  // The right hand and elbow as last posed, for a bat, knife or throwable held in it.
  heldHand: V(),
  heldElbow: V(),
};

/**
 * Melee weapons and throwables in the hand: geometry along its +y from the grip (origin), and its colour. CrowdView points
 * +y out of the fist (see heldItem).
 */
const HELD_COLOR: Readonly<Partial<Record<WeaponId, number>>> = { bat: 0x9b6b3c, knife: 0xb8bec6, grenade: 0x4c5a2c, molotov: 0x3d7a42 };
function heldGeometry(id: WeaponId): THREE.BufferGeometry | null {
  switch (id) {
    case 'bat':
      return new THREE.CylinderGeometry(0.035, 0.018, 0.86, 8).translate(0, 0.37, 0);
    case 'knife':
      return mergeAll([box(0.03, 0.1, 0.03, 0, 0.0, 0), box(0.012, 0.17, 0.035, 0, 0.13, 0)]);
    case 'grenade':
      return mergeAll([new THREE.SphereGeometry(0.045, 8, 6).scale(1, 1.25, 1).translate(0, 0.04, 0.02), box(0.02, 0.03, 0.02, 0, 0.1, 0.02)]);
    case 'molotov':
      return mergeAll([new THREE.CylinderGeometry(0.035, 0.035, 0.16, 8).translate(0, 0.05, 0), new THREE.CylinderGeometry(0.012, 0.03, 0.08, 8).translate(0, 0.17, 0), box(0.02, 0.05, 0.02, 0, 0.23, 0)]);
    default:
      return null;
  }
}

const ik = makeTwoBone();

/** Packed colours converted to the working colour space once (setHex does it with three pow calls). */
const colors = new Map<number, THREE.Color>();
function colorOf(hex: number): THREE.Color {
  let c = colors.get(hex);
  if (!c) {
    c = new THREE.Color(hex);
    colors.set(hex, c);
  }
  return c;
}

/** Deterministic per-character variation in 0..1. */
function seeded(id: number, salt: number): number {
  const x = Math.sin(id * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * What someone wears, beyond the colours the simulation gives him: sleeves to the wrist or to above the elbow, trousers
 * or shorts. By his id, so it is his for as long as he is in the world, and it draws nothing from the simulation's
 * random stream. The law and the player are always covered; it is a warm town, and half of the rest are not.
 */
/** Whether `c` is drawn as a woman: as the simulation has it (isWoman), which the voice of a shout follows too. */
function woman(c: Character, local: boolean): boolean {
  return !local && isWoman(c);
}

/**
 * How someone stands and walks, by his id (GaitStyle, and his stance): which leg he rests his weight on (1 left, -1
 * right), how far apart his feet stand (m, beyond his hips) and how far he puts the free one forward (m), how far his
 * toes turn out standing (rad), his elbows' bend hanging (rad), and how far he leans (rad, unarmed). A woman steps
 * nearer the line under her hips; nobody's feet come so near it that the shoes would touch passing (0.08 m either side).
 */
interface Style extends GaitStyle {
  support: number;
  apart: number;
  free: number;
  toe: number;
  hang: number;
  slouch: number;
}

function styleOf(c: Character, local: boolean, out: Style): Style {
  const id = c.id;
  const s = c.appearance.height;
  const she = woman(c, local);
  out.swing = (she ? 0.85 : 0.9) + 0.35 * seeded(id, 43);
  out.elbow = 0.25 * (seeded(id, 44) - 0.4);
  const hx = hipSpread(c.appearance.build);
  out.width = Math.max(STEP_CLEAR / hx, (she ? 0.7 : 0.8) + 0.15 * seeded(id, 47));
  out.support = seeded(id, 40) < 0.5 ? 1 : -1;
  out.apart = (she ? 0.005 : 0.015) + 0.025 * seeded(id, 47);
  // The free foot forward, but no further than keeps its toe inside his collision circle (Character.radius, 0.35 m)
  // for the broadest of builds: the shoe is SHOE_HALF wide either side whatever his height, and its toe reaches
  // SKELETON.toe x height ahead of the ankle.
  const side = hx + out.apart + SHOE_HALF;
  const room = Math.sqrt(Math.max(0, FOOT_REACH * FOOT_REACH - side * side)) - SKELETON.toe * s;
  out.free = Math.min((0.035 + 0.045 * seeded(id, 41)) * s, room);
  out.toe = (she ? 0.06 : 0.1) + 0.12 * seeded(id, 42);
  out.hang = 0.15 + 0.3 * seeded(id, 44);
  out.slouch = 0.07 * (seeded(id, 45) - 0.5);
  return out;
}

/**
 * Standing on one leg: the other hip joint sits this far lower (m, height 1), so that knee bends 15 to 20 degrees with
 * its foot set forward, while the leg he stands on stays straight under him (standing, a hip joint is within a
 * millimetre of the leg's reach: a foot set forward without it would leave the ground). The joint sinks into the hips
 * as drawn; only someone at rest with nothing in his hands also moves them, this far over the leg he stands on and
 * half the drop down.
 */
const STAND_SHIFT = 0.045;
const STAND_DROP = 0.02;
/**
 * The shoe's half-width (m, characterGeometry's sole: it does not scale with height); a walking foot's centre keeps
 * STEP_CLEAR from the line under his hips so two shoes never touch passing; a standing foot's toe stays within
 * FOOT_REACH of his centre (inside the 0.35 m collision circle, with room for the toe's turn out).
 */
const SHOE_HALF = 0.075;
const STEP_CLEAR = SHOE_HALF + 0.005;
const FOOT_REACH = 0.34;

function shortSleeved(c: Character, local: boolean): boolean {
  if (local || c.role === 'player' || c.role === 'swat') return false;
  return seeded(c.id, 31) < (c.role === 'cop' ? 0.4 : 0.55);
}

function inShorts(c: Character, local: boolean): boolean {
  if (local || c.role === 'player' || c.isLaw) return false;
  return seeded(c.id, 32) < 0.24;
}

/**
 * What someone wears beyond the simulation's colours (characterPaint's styles), by his id: the top (0 a tee, 1 a V neck,
 * 2 a shirt, 3 a uniform shirt, 4 a jacket open over a shirt) and its second colour (the skin in a V, the shirt under a
 * jacket), a jacket zipped or buttoned, a top worn over the belt or tucked in, a shirt's or jacket's collar, a belt
 * (its colour, or 0 for none), jeans, and shoes and their soles. The player wears his zipped jacket over a pale shirt,
 * jeans and a belt; the law its uniform, a black belt and boots.
 */
interface Dress {
  top: number;
  inner: number;
  zip: boolean;
  untucked: boolean;
  collar: boolean;
  belt: number;
  jeans: boolean;
  shoe: number;
  sole: number;
}

/** Belts: dark brown, black, tan. */
const BELTS = [0x2e1f15, 0x141414, 0x6e4c2c];
/** Shoes and their soles: white trainers, dark trainers with white soles, black and brown leather, canvas in red. */
const SHOES: ReadonlyArray<readonly [number, number, number]> = [
  [0.3, 0xe6e6e1, 0xf0f0ec], [0.25, 0x272d34, 0xe4e4e2], [0.22, 0x19191b, 0x2b2622], [0.15, 0x5b3b23, 0x2b2622], [0.08, 0x9c2b25, 0xeeeeea],
];
/** Pants colours drawn as denim, which takes the stitching of jeans on some (sim/appearance.ts PANTS). */
const DENIM = new Set([0x2c3e50, 0x34495e, 0x2e4053, 0x154360]);

/** The player's jacket hem: its lower edge 10 cm over the hip joints, above the belt, and 0.55 of a hem's height. */
const PLAYER_HEM = { y: 0.1, k: 0.55 } as const;

/**
 * A man's beard, by his id (characterPaint's FACE, vStyle.x): none for most, stubble, a moustache, a short beard or
 * a goatee. The player has stubble.
 */
function beardOf(id: number, local: boolean): number {
  if (local) return 1;
  const b = seeded(id, 59);
  return b < 0.55 ? 0 : b < 0.7 ? 1 : b < 0.8 ? 2 : b < 0.92 ? 3 : 4;
}

function dressOf(c: Character, local: boolean, out: Dress): Dress {
  const id = c.id;
  if (local) {
    Object.assign(out, { top: 4, inner: 0xc8c7bc, zip: true, untucked: true, collar: true, belt: BELTS[0]!, jeans: true, shoe: 0x272d34, sole: 0xe4e4e2 });
    return out;
  }
  if (c.isLaw) {
    Object.assign(out, { top: 3, inner: 0, zip: false, untucked: false, collar: true, belt: BELTS[1]!, jeans: false, shoe: 0x141518, sole: 0x141518 });
    return out;
  }
  const short = shortSleeved(c, local);
  const t = seeded(id, 50);
  out.top = !short && seeded(id, 21) > 0.55 ? 4 : t < 0.5 ? 0 : t < 0.75 ? 1 : 2;
  out.inner = out.top === 1 ? c.appearance.skin : seeded(id, 22) > 0.5 ? 0xe1ddd0 : 0x283b48;
  out.zip = seeded(id, 51) < 0.5;
  out.untucked = out.top === 4 || seeded(id, 52) < (out.top === 2 ? 0.35 : 0.65);
  out.collar = out.top === 2 || out.top === 4;
  out.belt = seeded(id, 53) < 0.7 ? BELTS[Math.floor(seeded(id, 54) * BELTS.length)]! : 0;
  out.jeans = DENIM.has(c.appearance.pants) && seeded(id, 55) < 0.75;
  let k = seeded(id, 56);
  let shoe = SHOES[SHOES.length - 1]!;
  for (const s of SHOES) {
    if (k < s[0]) {
      shoe = s;
      break;
    }
    k -= s[0];
  }
  out.shoe = shoe[1];
  out.sole = shoe[2];
  return out;
}

/** Recoil strength 0..1 from the time left on the shot timer. */
export function kickAmount(shotTimer: number): number {
  return shotTimer > 0 ? clamp(shotTimer / KICK_HOLD, 0, 1) : 0;
}

export class CrowdView {
  readonly group = new THREE.Group();
  private readonly parts: Record<PartName, Part>;
  private readonly weapons = new Map<WeaponId, Part>();
  /** A witness's phone held to his ear (Character.phoneTimer). */
  private readonly phone: Part;
  /** Per-character pose smoothing: the lying angle, and the gait and airborne weights. */
  private readonly lie = new Map<number, Anim>();
  /** Hide this character id (e.g. the player in first-person-ish shots). */
  hiddenId = -1;
  /** Also hidden: the player looking through a rifle scope from his own eye. */
  scopeHiddenId = -1;
  private frame = 0;
  private time = 0;
  /** The character this screen's player controls: dressed as the player, and the one a gun-pointed ped reacts to. */
  private player: Character | null = null;
  private readonly trunk: Trunk = makeTrunk();
  private readonly gaitOut = makeGaitOut();
  private readonly style: Style = { swing: 1, elbow: 0, width: 1, support: 1, apart: 0, free: 0, toe: 0, hang: 0, slouch: 0 };
  private readonly wp: WeaponPose = makeWeaponPose();
  /** The sea whose drawn waves swimmers ride (bindSea). */
  private sea: SeaWaveUniforms | null = null;
  /**
   * Per character drawn: its shot timer last frame, the value the timer had on the frame of its latest shot (it went
   * up: a shot was fired), and the frame it was last drawn. See kickOf.
   */
  private readonly shots = new Map<number, { last: number; fired: number; frame: number; event?: number }>();
  /** Height each vehicle kind's view rotates about (see VehicleView). */
  private readonly pivots = new Map<VehicleKind, number>();
  private readonly seat: RiderSeat = { y: 0, z: 0, recline: 0 };
  private readonly muzzle = { x: 0, y: 0, z: 0 };
  /** Fades by character (object identity: ids start again in a new session). */
  private readonly fades = new Map<Character, Fade>();
  /** The fade every instance put now is drawn with. */
  private drawFade = 1;
  /** And, for a part with two shapes, its share of the second (a woman's torso and hips: 1). */
  private drawShape = 0;
  /** And, for a painted part, its second colour and style (characterPaint). */
  private drawTrim = 0;
  private readonly drawStyle = [0, 0, 0, 0];
  /** What the character being posed wears (dressOf, in torso(), which every pose draws first). */
  /** The player's shortened jacket hem (torso()). */
  private readonly hemMatrix = new THREE.Matrix4();
  private readonly dress: Dress = { top: 0, inner: 0, zip: false, untucked: false, collar: false, belt: 0, jeans: false, shoe: 0, sole: 0 };
  /**
   * The latest characters drawn for the first time (on foot): id, place, and the fade of that first frame. For checks
   * in the browser (`__gta7.game.renderer.crowd.firstDrawn`); holds the last FIRST_DRAWN_LOG.
   */
  readonly firstDrawn: Array<{ id: number; x: number; z: number; fade: number; frame: number }> = [];

  constructor() {
    this.group.name = 'crowd';
    const mat = (vertexColors: boolean, shaped: boolean, paint?: { name: string; glsl: string; masked: boolean }) => {
      const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.83, metalness: 0, vertexColors });
      m.onBeforeCompile = shaped || paint
        ? (shader) => {
            fadeNearLens(shader);
            if (shaped) shapeByInstance(shader);
            if (paint) paintShader(shader, paint.glsl, paint.masked);
          }
        : fadeNearLens;
      // Three keys a program on the text of onBeforeCompile, which is one closure for every painted part.
      if (paint) m.customProgramCacheKey = () => `crowd-paint:${paint.name}:${shaped}`;
      if (paint?.name === 'hand') {
        m.side = THREE.DoubleSide;
        const base = m.onBeforeCompile;
        m.onBeforeCompile = (shader, renderer) => {
          base.call(m, shader, renderer);
          mirroredHand(shader);
        };
      }
      m.userData.contactShadow = false; // Keep dissolved character parts out of the contact depth pass.
      return m;
    };
    const depth = characterDepthMaterial();
    const depthShaped = characterDepthMaterial(true);
    const make = (geo: THREE.BufferGeometry, count: number, name?: PartName): Part => {
      geo.setAttribute('instanceFade', new THREE.InstancedBufferAttribute(new Float32Array(count).fill(1), 1).setUsage(THREE.DynamicDrawUsage));
      const shaped = geo.hasAttribute('positionB');
      const shape = shaped ? new Float32Array(count) : undefined;
      if (shape) geo.setAttribute('instanceShape', new THREE.InstancedBufferAttribute(shape, 1).setUsage(THREE.DynamicDrawUsage));
      const glsl = name ? PAINT[name] : undefined;
      const trim = glsl ? new Float32Array(count * 3) : undefined;
      const style = glsl ? new Float32Array(count * 4) : undefined;
      if (trim && style) {
        geo.setAttribute('instanceTrim', new THREE.InstancedBufferAttribute(trim, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('instanceStyle', new THREE.InstancedBufferAttribute(style, 4).setUsage(THREE.DynamicDrawUsage));
      }
      const paint = name && glsl ? { name, glsl, masked: geo.hasAttribute('trimMask') } : undefined;
      const mesh = new THREE.InstancedMesh(geo, mat(geo.hasAttribute('color'), shaped, paint), count);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.customDepthMaterial = shaped ? depthShaped : depth;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Allocate the colour buffer up front.
      mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      this.group.add(mesh);
      return { mesh, n: 0, shape, trim, style };
    };
    const geometry = characterGeometries();
    const pairs = new Set<PartName>(['upperArm', 'forearm', 'hand', 'thigh', 'shin', 'shoe', 'sleeve', 'shortLeg', 'shoulder']);
    this.parts = Object.fromEntries(Object.entries(geometry).map(([name, geo]) => {
      const p = make(geo, MAX * (pairs.has(name as PartName) ? 2 : 1), name as PartName);
      p.mesh.name = 'character-' + name;
      return [name, p];
    })) as Record<PartName, Part>;
    // Modelled guns (weaponModels.ts): muzzle, grip and stock on the WEAPON_POINTS of sim/pose.ts.
    const weaponGeo = Object.fromEntries(GUN_IDS.map((g) => [g, gunGeometry(g)])) as Partial<Record<Gun, THREE.BufferGeometry>>;
    this.phone = make(box(0.05, 0.1, 0.016, 0, 0.03, 0), MAX);
    this.phone.mesh.name = 'held-phone';
    for (const id of ['bat', 'knife', 'grenade', 'molotov'] as const) {
      const geo = heldGeometry(id);
      if (!geo) continue;
      const p = make(geo, MAX);
      p.mesh.name = 'held-' + id;
      this.weapons.set(id, p);
    }
    for (const [id, geo] of Object.entries(weaponGeo) as Array<[Gun, THREE.BufferGeometry]>) {
      const p = make(geo, MAX);
      // The model's vertex colours carry its finish (steel, polymer, wood); the material only shades it.
      p.mesh.name = 'gun-' + id;
      (p.mesh.material as THREE.MeshStandardMaterial).metalness = 0.45;
      (p.mesh.material as THREE.MeshStandardMaterial).roughness = 0.5;
      this.weapons.set(id, p);
    }
  }

  /** Where every head drawn last frame turns (the neck pivot, the head's origin), for tests and browser checks. */
  drawnHeads(): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    const head = this.parts.head.mesh;
    const m = new THREE.Matrix4();
    if (head.visible) {
      for (let i = 0; i < head.count; i++) {
        head.getMatrixAt(i, m);
        out.push(new THREE.Vector3().setFromMatrixPosition(m));
      }
    }
    return out;
  }

  /** The drawn gun of `gun`; a weapon with no model of its own is drawn as the pistol. */
  private weaponPart(gun: Gun): Part {
    return this.weapons.get(gun) ?? this.weapons.get('pistol')!;
  }

  /** Notes `c`'s shot timer for this frame: one that went up since the last frame is a shot fired on this one. */
  private trackShot(c: Character): void {
    const t = c.shotTimer;
    const s = this.shots.get(c.id);
    if (!s) {
      // First seen: nothing to compare with, so not taken for a shot frame.
      this.shots.set(c.id, { last: t, fired: NaN, frame: this.frame });
      return;
    }
    if (s.frame === this.frame) return;
    if (t > s.last) s.fired = t;
    s.last = t;
    s.frame = this.frame;
  }

  /**
   * The recoil drawn on `c`'s gun this frame (0..1 of KICK): none while his shot timer still reads what it did on the
   * frame he fired (also while paused there), so the flash and the tracer start at the barrel end as drawn; then
   * kickAmount.
   */
  private kickOf(c: Character): number {
    const t = c.shotTimer;
    const s = this.shots.get(c.id);
    // Another player's shot timer comes in his snapshots, which can run ahead of the shot itself: his gun kicks
    // only once the frame that draws his tracer is past, so that tracer too leaves the barrel end as drawn.
    if (this.player && c.role === 'player' && c !== this.player && (s?.event === undefined || this.frame <= s.event + 1)) return 0;
    return t > 0 && t === s?.fired ? 0 : kickAmount(t);
  }

  private readonly muzzlePose = makeWeaponPose();
  private readonly muzzleOut = new THREE.Vector3();

  /**
   * Where `c`'s drawn gun has its muzzle this frame: the sim's barrel end moved by the drawn recoil (kickOf), for a
   * character on foot; null without a gun. Effects keeps a muzzle flash on it while the gun kicks.
   */
  muzzleOf(c: Character): THREE.Vector3 | null {
    const gun = c.inventory.current;
    if (!isGun(gun) || c.removed || c.state === 'inVehicle' || c.state === 'swimming') return null;
    const w = weaponPoseInto(c, this.muzzlePose);
    const g = gun as Gun;
    const pts = WEAPON_POINTS[g];
    const kick = this.kickOf(c);
    const m = this.weaponMatrix(w, kick * gunKick(g), g === 'pistol' ? pts.grip : pts.stock, KICK_BACK * kick);
    return this.muzzleOut.set(pts.tip.x, pts.tip.y, pts.tip.z).applyMatrix4(m);
  }

  /** A shot by character `id` is drawn from the next frame (the renderer's shot events): see kickOf. */
  noteShot(id: number): void {
    const s = this.shots.get(id);
    if (s) s.event = this.frame;
  }

  private put(part: Part, m: THREE.Matrix4, color: number): void {
    if (part.n >= part.mesh.instanceMatrix.count) return;
    // Shoes are put by every pose: they are the wearer's, with their soles.
    if (part === this.parts.shoe) {
      color = this.dress.shoe;
      this.paint(this.dress.sole, 0);
    }
    part.mesh.setMatrixAt(part.n, m);
    part.mesh.setColorAt(part.n, colorOf(color));
    (part.mesh.geometry.getAttribute('instanceFade').array as Float32Array)[part.n] = this.drawFade;
    if (part.shape) part.shape[part.n] = this.drawShape;
    if (part.trim && part.style) {
      const t = colorOf(this.drawTrim);
      part.trim.set([t.r, t.g, t.b], part.n * 3);
      part.style.set(this.drawStyle, part.n * 4);
    }
    part.n++;
  }

  /** The second colour and style the next painted parts are put with (characterPaint). */
  private paint(trim: number, x: number, y = 0, z = 0): void {
    this.drawTrim = trim;
    this.drawStyle[0] = x;
    this.drawStyle[1] = y;
    this.drawStyle[2] = z;
  }

  /** The fade (0..1) `c` was last drawn with, or undefined when it was not drawn. */
  fadeOf(c: Character): number | undefined {
    return this.fades.get(c)?.f;
  }

  /** Clears every fade (a new session: none of the old characters fade out over the new one). */
  reset(): void {
    this.fades.clear();
    this.firstDrawn.length = 0;
  }

  /**
   * `localCharacterId` is the id of the character the local player controls. Other players' characters are drawn as
   * ordinary characters in their own appearance.
   */
  sync(chars: readonly Character[], camX: number, camZ: number, dt: number, localCharacterId = -1): void {
    for (const p of Object.values(this.parts)) p.n = 0;
    for (const p of this.weapons.values()) p.n = 0;
    this.phone.n = 0;
    this.frame++;
    this.time += dt;
    this.player = null;
    for (const c of chars) {
      if (c.id === localCharacterId && !c.removed) {
        this.player = c;
        break;
      }
    }
    for (const c of chars) {
      if (c.removed || c.id === this.hiddenId || c.id === this.scopeHiddenId) continue;
      if (c.state === 'inVehicle') {
        // Riders come and go with their car, which does not fade: whole, and whole when they get out.
        this.fadeFor(c, true, dt).foot = false;
        const v = c.vehicle;
        // A burning car still shows who is in it (until he gets out or it blows up).
        if (!v || v.removed || v.destroyed) continue;
        if ((v.pos.x - camX) ** 2 + (v.pos.z - camZ) ** 2 > OCCUPANT_RANGE * OCCUPANT_RANGE) continue;
        // A bike's or boat's riders fade with it (riders.ts RiderMount.level).
        this.drawFade = v.spec.class === 'car' ? 1 : (riderMount(v)?.level ?? 1);
        this.trackShot(c);
        this.seated(c, v);
        continue;
      }
      if ((c.pos.x - camX) ** 2 + (c.pos.z - camZ) ** 2 > 200 * 200) continue;
      // Player characters (the local one and the other players' in multiplayer) are whole at once; pedestrians fade in.
      const fade = this.fadeFor(c, c === this.player || c.role === 'player', dt);
      fade.foot = true;
      this.drawFade = fade.f;
      this.trackShot(c);
      this.poseOnFoot(c, dt);
    }
    // Characters removed while drawn on foot (a body or a despawned ped) fade out where they were; the rest are gone.
    for (const [c, s] of this.fades) {
      if (s.frame === this.frame) continue;
      if (!s.out && c.removed && s.f > 0 && s.foot) s.out = true;
      if (s.out) s.f -= dt / PED_FADE_OUT;
      if (!s.out || s.f <= 0) {
        this.fades.delete(c);
        continue;
      }
      s.frame = this.frame;
      this.drawFade = s.f;
      this.poseOnFoot(c, dt);
    }
    this.drawFade = 1;
    for (const [id, a] of this.lie) if (a.frame !== this.frame) this.lie.delete(id);
    for (const [id, s] of this.shots) if (s.frame !== this.frame) this.shots.delete(id);
    const finish = (p: Part) => {
      p.mesh.count = p.n;
      p.mesh.instanceMatrix.needsUpdate = true;
      if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
      p.mesh.geometry.getAttribute('instanceFade').needsUpdate = true;
      if (p.shape) p.mesh.geometry.getAttribute('instanceShape').needsUpdate = true;
      if (p.trim) {
        p.mesh.geometry.getAttribute('instanceTrim').needsUpdate = true;
        p.mesh.geometry.getAttribute('instanceStyle').needsUpdate = true;
      }
    };
    for (const p of Object.values(this.parts)) finish(p);
    for (const p of this.weapons.values()) finish(p);
    finish(this.phone);
  }

  /**
   * The fade `c` is drawn with this frame: 0 the first time (the player and riders whole at once), then up by
   * dt / PED_FADE_IN a frame.
   */
  private fadeFor(c: Character, whole: boolean, dt: number): Fade {
    let s = this.fades.get(c);
    if (!s) {
      s = { f: whole ? 1 : 0, out: false, frame: this.frame, foot: false };
      this.fades.set(c, s);
      if (!whole) {
        this.firstDrawn.push({ id: c.id, x: c.pos.x, z: c.pos.z, fade: 0, frame: this.frame });
        if (this.firstDrawn.length > FIRST_DRAWN_LOG) this.firstDrawn.shift();
      }
    } else {
      s.f = whole ? 1 : Math.min(1, s.f + dt / PED_FADE_IN);
      s.out = false;
    }
    s.frame = this.frame;
    return s;
  }

  private poseOnFoot(c: Character, dt: number): void {
    let anim = this.lie.get(c.id);
    if (!anim) {
      anim = { lie: c.state === 'dead' || c.state === 'knocked' ? 1 : 0, walk: c.speed > 0.3 ? 1 : 0, air: c.onGround ? 0 : 1, ease: 0, frame: 0, yaw: c.heading, turn: 0, shift: 0, stepper: -1, loose: 1 };
      this.lie.set(c.id, anim);
    }
    anim.frame = this.frame;
    this.pose(c, anim, dt);
  }

  // ---------------------------------------------------------------------------
  // Matrices

  /**
   * A limb hanging from joint a to joint b (its local -y runs from a towards b), its local x turned
   * towards `side`, its length scaled by `sy`. Leaves the unit basis in S.bx/by/bz.
   */
  private bone(part: Part, a: THREE.Vector3, b: THREE.Vector3, side: THREE.Vector3, sy: number, color: number, girth = 1): void {
    const Y = S.by.subVectors(a, b);
    const l = Y.length();
    if (l > 1e-9) Y.divideScalar(l);
    else Y.set(0, 1, 0);
    const X = S.bx.copy(side).addScaledVector(Y, -side.dot(Y));
    if (X.lengthSq() < 1e-10) {
      // `side` runs along the bone: take the twist from the world axis least aligned with it.
      if (Math.abs(Y.y) < 0.9) X.set(0, 1, 0).addScaledVector(Y, -Y.y);
      else X.set(1, 0, 0).addScaledVector(Y, -Y.x);
    }
    X.normalize();
    const Z = S.bz.crossVectors(X, Y);
    S.inst.makeBasis(X, Y, Z).scale(S.sc.set(girth, sy, girth)).setPosition(a);
    this.put(part, S.inst, color);
  }

  /** Upper arm, forearm and hand from the shoulder to the elbow to the centre of the hand. */
  private arm(shoulder: THREE.Vector3, elbow: THREE.Vector3, hand: THREE.Vector3, side: THREE.Vector3, c: Character): void {
    const s = c.appearance.height;
    const a = c.appearance;
    const wrist = S.wrist.copy(elbow).lerp(hand, SKELETON.forearm / (SKELETON.forearm + SKELETON.hand));
    const local = c === this.player;
    const g = woman(c, local) ? WOMAN.arm : 1;
    // Which way the upper arm's outside faces in its own frame (its x is `side` for both arms), for a patch on it.
    const out = shoulder === S.shR ? -1 : 1;
    if (shortSleeved(c, local)) {
      // A bare arm, slimmer than a sleeve, with the sleeve over its top.
      this.bone(this.parts.sleeve, shoulder, elbow, side, s, a.shirt, g);
      this.paint(0, 0);
      this.bone(this.parts.upperArm, shoulder, elbow, side, s, a.skin, BARE_ARM * g);
      this.bone(this.parts.forearm, elbow, wrist, side, s, a.skin, BARE_ARM * g);
    } else {
      // An officer's sleeve carries the force's patch: navy with a gold edge.
      this.paint(0x1b2550, 1, out, c.isLaw ? 1 : 0);
      this.bone(this.parts.upperArm, shoulder, elbow, side, s, a.shirt, g);
      this.bone(this.parts.forearm, elbow, wrist, side, s, a.shirt, g);
    }
    // The right hand is the left one mirrored (mirroredHand), its palm to the body as the left's is.
    S.inst.makeBasis(S.bx, S.by, S.bz).scale(S.sc.set(out * s * g, s, s * g)).setPosition(hand);
    this.put(this.parts.hand, S.inst, a.skin);
  }

  /** Thigh and shin from the hip to the knee to the ankle: trouser legs, or shorts over bare ones. */
  private leg(hip: THREE.Vector3, knee: THREE.Vector3, ankle: THREE.Vector3 | null, side: THREE.Vector3, c: Character): void {
    const s = c.appearance.height;
    const a = c.appearance;
    const local = c === this.player;
    const g = woman(c, local) ? WOMAN.leg : 1;
    if (inShorts(c, local)) {
      this.bone(this.parts.shortLeg, hip, knee, side, s, a.pants, g);
      this.bone(this.parts.thigh, hip, knee, side, s, a.skin, BARE_LEG * g);
      if (ankle) this.bone(this.parts.shin, knee, ankle, side, s, a.skin, BARE_LEG * g);
    } else {
      this.bone(this.parts.thigh, hip, knee, side, s, a.pants, g);
      if (ankle) this.bone(this.parts.shin, knee, ankle, side, s, a.pants, g);
    }
  }

  /** Arm by two-bone IK from the shoulder to a hand target, the elbow bending towards `pole`. Returns the hand. */
  private armTo(shoulder: THREE.Vector3, target: THREE.Vector3, pole: THREE.Vector3, side: THREE.Vector3, c: Character): THREE.Vector3 {
    const s = c.appearance.height;
    solveTwoBone(shoulder.x, shoulder.y, shoulder.z, target.x, target.y, target.z, SKELETON.upperArm * s, (SKELETON.forearm + SKELETON.hand) * s, pole.x, pole.y, pole.z, ik);
    S.elbow.set(ik.mx, ik.my, ik.mz);
    S.hand.set(ik.ex, ik.ey, ik.ez);
    this.arm(shoulder, S.elbow, S.hand, side, c);
    return S.hand;
  }

  /** Limb direction in the body frame: pitched (- forward) after spreading `spread` away from the body on side `sign`. */
  private limbDir(pitch: number, spread: number, sign: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.sin(sign * spread), -Math.cos(spread) * Math.cos(pitch), -Math.cos(spread) * Math.sin(pitch)).transformDirection(S.body);
  }

  /** Arm by angles in the body frame: shoulder pitch, abduction, elbow flex forward and elbow bend outward. */
  private armFK(shoulder: THREE.Vector3, sign: number, pitch: number, abduct: number, elbowFwd: number, elbowOut: number, c: Character): void {
    const s = c.appearance.height;
    S.elbow.copy(shoulder).addScaledVector(this.limbDir(pitch, abduct, sign, S.d1), SKELETON.upperArm * s);
    S.hand.copy(S.elbow).addScaledVector(this.limbDir(pitch - elbowFwd, abduct + elbowOut, sign, S.d2), (SKELETON.forearm + SKELETON.hand) * s);
    this.arm(shoulder, S.elbow, S.hand, S.left, c);
  }

  /**
   * Leg by angles in the body frame: hip pitch (- forward), spread, knee flex; the foot at right angles to
   * the shin, its toes turned towards the knee by `ankle` (negative points them).
   */
  private legFK(hip: THREE.Vector3, sign: number, pitch: number, spread: number, knee: number, ankle: number, c: Character): void {
    const s = c.appearance.height;
    S.knee.copy(hip).addScaledVector(this.limbDir(pitch, spread, sign, S.d1), SKELETON.thigh * s);
    S.ankle.copy(S.knee).addScaledVector(this.limbDir(pitch + knee, spread, sign, S.d2), SKELETON.shin * s);
    this.leg(hip, S.knee, S.ankle, S.left, c);
    S.e.set(pitch + knee - ankle, 0, sign * spread, 'YXZ');
    S.inst.copy(S.body).multiply(S.rot.makeRotationFromEuler(S.e)).scale(S.sc.set(1, s, s)).setPosition(S.ankle);
    this.put(this.parts.shoe, S.inst, 0xffffff);
  }

  /** Shoe at the ankle, facing `yaw`, pitched (+ toe up). */
  private shoe(ankle: THREE.Vector3, yaw: number, pitch: number, s: number): void {
    S.e.set(-pitch, yaw, 0, 'YXZ');
    S.q.setFromEuler(S.e);
    S.inst.compose(ankle, S.q, S.sc.set(1, s, s));
    this.put(this.parts.shoe, S.inst, 0xffffff);
  }

  /** Torso, neck, head and hair or hat on the body frame S.body at the pelvis, the head turned and pitched (- up). Sets S.neck. */
  private torso(c: Character, pelvis: THREE.Vector3, headPitch: number, headYaw = 0): void {
    const a = c.appearance;
    const s = a.height;
    const local = c === this.player;
    const she = woman(c, local);
    const d = dressOf(c, local, this.dress);
    S.inst.copy(S.body).scale(S.sc.set(a.build, s, a.build)).setPosition(pelvis);
    this.drawShape = she ? 1 : 0;
    this.paint(d.inner, d.top, d.zip ? 1 : 0);
    this.put(this.parts.torso, S.inst, a.shirt);
    if (d.untucked && local) {
      // The player's jacket ends at a ribbed band over his belt, which shows under it from the camera behind him.
      this.hemMatrix.copy(S.inst).multiply(S.rot.makeTranslation(0, PLAYER_HEM.y - 0.035 * PLAYER_HEM.k, 0)).multiply(S.rot2.makeScale(1, PLAYER_HEM.k, 1));
      this.put(this.parts.hem, this.hemMatrix, a.shirt);
    } else if (d.untucked) this.put(this.parts.hem, S.inst, a.shirt);
    if (d.collar) this.put(this.parts.collar, S.inst, a.shirt);
    this.paint(d.belt, d.belt ? 1 : 0, d.jeans ? 1 : 0);
    this.put(this.parts.hips, S.inst, a.pants);
    this.drawShape = 0;
    this.put(this.parts.neck, S.inst, a.skin);
    if (c.isLaw) {
      // Cut to the man's torso: on hers it is drawn in a little, so the badge lies on her chest and the belt on her hips.
      if (she) S.inst.copy(S.body).scale(S.sc.set(a.build * WOMAN.badge.x, s, a.build * WOMAN.badge.z)).setPosition(pelvis);
      this.put(this.parts.badge, S.inst, 0xffffff);
    }
    S.neck.set(0, 1, 0).transformDirection(S.body).multiplyScalar(SKELETON.neckY * s).add(pelvis);
    S.e.set(headPitch, headYaw, 0, 'YXZ');
    // Faces of their own width, a woman's a little narrower; everything worn on the head goes with it.
    const wide = (she ? 0.95 : 1) * (0.95 + 0.1 * seeded(c.id, 57));
    S.inst.copy(S.body).multiply(S.rot.makeRotationFromEuler(S.e)).scale(S.sc.set(s * wide, s, s)).setPosition(S.neck);
    // Brows in the hair's colour, heavier or lighter by his id, and a beard on some men (characterPaint's FACE).
    this.drawShape = she ? 1 : 0;
    this.paint(a.hair, she ? 0 : beardOf(c.id, local), she ? 1 : 0, seeded(c.id, 58));
    this.put(this.parts.head, S.inst, a.skin);
    this.drawShape = 0;
    this.put(this.parts.face, S.inst, 0xffffff);
    // How the hair is worn, by his or her id: cropped (the cap alone), swept, long, tied back or full; the cap shows
    // under a hat at the sides and the nape.
    const h = seeded(c.id, 23);
    if (a.hat) {
      this.put(this.parts.hat, S.inst, a.hat);
      // Long hair shows under a cap; or the cap of hair does.
      this.put(she && h < 0.7 ? this.parts.hairLong : this.parts.hair, S.inst, a.hair);
    } else {
      this.put(this.parts.hair, S.inst, a.hair);
      if (local) {
        // The player's is cropped.
      } else if (she) {
        if (h < 0.45) this.put(this.parts.hairLong, S.inst, a.hair);
        else if (h < 0.75) this.put(this.parts.hairTail, S.inst, a.hair);
        else if (h < 0.88) this.put(this.parts.hairFull, S.inst, a.hair);
        else this.put(this.parts.hairSweep, S.inst, a.hair);
      } else if (h > 0.86) this.put(this.parts.hairFull, S.inst, a.hair);
      else if (h > 0.45) this.put(this.parts.hairSweep, S.inst, a.hair);
    }
    if (!local && seeded(c.id, 24) > 0.72) this.put(this.parts.glasses, S.inst, 0xffffff);
  }

  /** Body frame axes into S.left/up/fwd and the shoulder joints into S.shL/shR. */
  private shoulders(c: Character, pelvis: THREE.Vector3): void {
    const s = c.appearance.height;
    S.left.set(1, 0, 0).transformDirection(S.body);
    S.up.set(0, 1, 0).transformDirection(S.body);
    S.fwd.set(0, 0, 1).transformDirection(S.body);
    // Drawn nearer the spine and lower than the simulation's joints (DRAWN_SHOULDER): hands go where it puts them.
    const sx = (DRAWN_SHOULDER.x * c.appearance.build + DRAWN_SHOULDER.pad) * (woman(c, c === this.player) ? WOMAN.shoulders : 1);
    const shY = (SKELETON.shoulderY - DRAWN_SHOULDER.drop) * s;
    S.shL.copy(pelvis).addScaledVector(S.up, shY).addScaledVector(S.left, sx);
    S.shR.copy(pelvis).addScaledVector(S.up, shY).addScaledVector(S.left, -sx);
    // The deltoids over the tops of the arms, on the chest's frame.
    const g = woman(c, c === this.player) ? WOMAN.arm : 1;
    for (const sh of [S.shL, S.shR]) {
      S.inst.copy(S.body).scale(S.sc.set(s * g, s, s * g)).setPosition(sh);
      this.put(this.parts.shoulder, S.inst, c.appearance.shirt);
    }
  }

  /**
   * The drawn weapon matrix (into S.weapon): the pose frame, with the muzzle kicked up by `angle` about the
   * weapon-local `pivot` and pushed back by `back`.
   */
  private weaponMatrix(w: WeaponPose, angle: number, pivot: P3, back: number): THREE.Matrix4 {
    const m = S.weapon;
    S.bx.set(w.left.x, w.left.y, w.left.z);
    S.by.set(w.up.x, w.up.y, w.up.z);
    S.bz.set(w.dir.x, w.dir.y, w.dir.z);
    m.makeBasis(S.bx, S.by, S.bz).setPosition(w.origin.x, w.origin.y, w.origin.z);
    if (angle === 0 && back === 0) return m;
    // Weapon-local: about the pivot, pitch the muzzle up (a negative turn about x), then push along -z.
    m.multiply(S.rot.makeTranslation(pivot.x, pivot.y, pivot.z - back))
      .multiply(S.rot2.makeRotationX(-angle))
      .multiply(S.rot.makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    return m;
  }

  // ---------------------------------------------------------------------------
  // Poses

  private pose(c: Character, anim: Anim, dt: number): void {
    // The rate his heading turns at, kept in every pose (a heading set while lying, swimming or paused is no turn).
    const upright = c.state !== 'swimming' && anim.lie <= 0.001 && c.state !== 'dead' && c.state !== 'knocked';
    if (dt > 0 && upright) anim.turn = damp(anim.turn, clamp(wrapAngle(c.heading - anim.yaw) / dt, -20, 20), TURN_EASE, dt);
    else if (!upright) anim.turn = 0;
    anim.yaw = c.heading;
    const lying = c.state === 'dead' || c.state === 'knocked';
    anim.lie += clamp((lying ? 1 : 0) - anim.lie, -dt * 3, dt * (c.onGround ? 5 : 2.2));
    if (c.state === 'swimming') {
      anim.lie = 0;
      this.swim(c);
    } else if (anim.lie > 0.001) {
      this.lying(c, anim.lie);
    } else {
      this.upright(c, anim, dt);
    }
  }

  /** Standing, walking, running, jumping, aiming, punching, cowering and climbing into a car. */
  private upright(c: Character, anim: Anim, dt: number): void {
    const a = c.appearance;
    const s = a.height;
    const bw = a.build;
    const t = trunkPose(c, this.trunk);
    const entering = c.state === 'entering';
    const grounded = c.onGround || entering;
    const was = anim.walk;
    anim.walk = damp(anim.walk, entering ? 1 : t.move, 10, dt);
    if (dt > 0) anim.shift = Math.abs(anim.walk - was) / dt;
    anim.air = damp(anim.air, grounded ? 0 : 1, 14, dt);
    // Standing still, the gait has no weight and is not worked out; otherwise it uses the trunk's gait
    // cycle when it has one (the same speed and direction).
    const idle = anim.walk < 1e-4 && !entering;
    const st = styleOf(c, c === this.player, this.style);
    const g = idle ? this.gaitOut : gait(c.animPhase, entering ? 1.8 : Math.max(0, c.speed), Math.atan2(t.mx, t.mz), this.gaitOut, s, bw, t.move > 0 && !entering ? t.cycle : null, st);
    const walk = idle ? 0 : anim.walk * (1 - anim.air);
    // Drawn hip height: the trunk's gait curve, eased in and out of standing and landings. The simulation
    // uses the curve unsmoothed: once a character walks or stands steadily the two agree to the millimetre
    // and the drawn barrel is the muzzle; for the fraction of a second it takes to fall into or out of a
    // stride they differ by at most the hip bob, a few centimetres, rather than the body popping.
    t.y = lerp(SKELETON.hipY * s, g.hipY, walk);

    const cower = c.brain?.mode === 'cower' && c.state === 'normal';
    const handsUp = cower && cowerHandsUp(c, this.player);
    const crouch = cower && !handsUp;
    const weapon = c.inventory.current;
    const armed = isGun(weapon) && !cower && !entering;
    const fists = !isGun(weapon) && !cower && !entering && (c.punchTimer > 0 || aimed(c));
    const held = !isGun(weapon) && weapon !== 'fists' && !cower && !entering ? weapon : null;
    const punch = fists && c.punchTimer > 0 ? Math.sin(Math.PI * clamp(1 - c.punchTimer / 0.32, 0, 1)) : 0;
    // Place of the punch in the combo: CombatSystem.melee counts meleeCombo on before the punch is thrown.
    const combo = (((c.meleeCombo + 2) % 3) + 3) % 3;

    // Weapon pose from the trunk before any drawn-only offsets, and its recoil.
    let kick = 0;
    if (armed) {
      weaponPoseInto(c, this.wp, t);
      kick = this.kickOf(c);
    }

    // Drawn-only trunk offsets: crouching, punch step and twist, recoil.
    let lean = t.lean;
    let chestYaw = t.chestYaw;
    let drop = 0;
    let step = 0;
    if (crouch) {
      drop = 0.35 * s;
      lean = 0.85;
    }
    if (punch > 0) {
      if (combo === 2) {
        // The hook turns the shoulders through and steps the lead (left) foot in.
        chestYaw += 0.5 * punch;
        lean += 0.12 * punch;
        step = 0.1 * punch;
      } else chestYaw += (combo === 0 ? 0.18 : -0.14) * punch;
    }
    if (kick > 0) lean -= 0.04 * kick * (gunKick(this.wp.weapon) / 0.12);
    // Hit: the trunk snaps back and to one side (by his id: a row of people does not flinch as one) and sinks a little,
    // and comes up again over the HURT_TIME the sim keeps him hurt; under a burst he stays rocked back. A bullet that
    // drew only a puff of red left him standing like a signpost.
    const hurt = c.alive && !crouch ? clamp(c.hurtTimer / HURT_TIME, 0, 1) : 0;
    if (hurt > 0) {
      const k = hurt * (2 - hurt);
      lean -= FLINCH_LEAN * k;
      chestYaw += (c.id % 2 ? FLINCH_TWIST : -FLINCH_TWIST) * k;
      drop += FLINCH_DROP * s * k;
    }

    // Standing about with nothing in hand he is no post: he breathes, his shoulders ease from side to side and he
    // looks up and down the street, each to his own time.
    // (Eased in and out over half a second or so: he does not snap his head round as he sets off, and one with a
    // phone at his ear or an arm up for a cab keeps his head where it is.)
    const easy = idle && !armed && !fists && !held && !cower && c.alive && hurt === 0 && c.phoneTimer <= 0 && c.hailTimer <= 0;
    anim.ease = damp(anim.ease, easy ? 1 : 0, IDLE_EASE, dt);
    let glance = 0;
    if (anim.ease > 1e-3) {
      const ph = this.time + c.id * 1.7;
      // (The breath and the sway are too small to see stop, and stop at once: a chest under a raised gun is where
      // the simulation has it. The glance is what eases.)
      if (easy) {
        lean += anim.ease * IDLE_BREATH * Math.sin(ph * 1.5);
        chestYaw += anim.ease * IDLE_SWAY * Math.sin(ph * 0.37);
      }
      glance = anim.ease * IDLE_GLANCE * Math.sin(ph * 0.23) * Math.min(1, Math.abs(Math.sin(ph * 0.11)) * 1.6);
    }

    // Turning (anim.turn, see pose), the head goes first, then the chest, and someone moving leans into the turn; the
    // hips follow the heading. Nothing added here moves the trunk of someone with a gun in hand: it is where the
    // simulation has it from the frame he draws (an aim pressed mid-turn drops the lean at once; it is back over a
    // fifth of a second when he puts the gun away).
    anim.loose = armed ? 0 : damp(anim.loose, 1, LOOSE_EASE, dt);
    const aim = aimed(c);
    const loose = anim.loose;
    chestYaw += loose * clamp(TURN_CHEST * anim.turn, -TURN_CHEST_MAX, TURN_CHEST_MAX);
    const bank = loose * clamp(-TURN_BANK * anim.turn * c.speed * walk, -TURN_BANK_MAX, TURN_BANK_MAX);
    // His own carriage: some walk tall, some a little stooped (not crouching: the simulation ducks him that far).
    if (!crouch) lean += loose * st.slouch;
    // At rest on one leg (anim.ease, as the glance): the hips over it and down a little.
    const rest = loose * anim.ease * (1 - walk);
    const shift = st.support * STAND_SHIFT * s * rest;
    const sag = STAND_DROP * s * (1 - walk);

    const hipYaw = t.hipYaw;
    const hc = Math.cos(hipYaw);
    const hs = Math.sin(hipYaw);
    const P = S.pelvis.set(c.pos.x + hc * shift, c.pos.y + t.y - drop - (sag / 2) * rest, c.pos.z - hs * shift);
    S.e.set(lean, chestYaw, bank, 'YXZ');
    S.body.makeRotationFromEuler(S.e);
    const headPitch = crouch ? 0.35 : aim ? -c.aimPitch * 0.6 - lean * 0.5 : -lean * 0.6;
    // Looking down the barrel of a shouldered gun, over the turned chest; otherwise into the turn.
    const lead = clamp(TURN_HEAD * anim.turn, -TURN_HEAD_MAX, TURN_HEAD_MAX);
    this.torso(c, P, headPitch, aim ? wrapAngle(t.armYaw - chestYaw) : glance + lead);
    this.shoulders(c, P);

    // Legs: planted gait feet, blended with standing feet, the crouch and the airborne tuck.
    const hipLeft = S.hipLeft.set(hc, 0, -hs);
    const hx = hipSpread(bw);
    const hipY = t.y - drop;
    const blend = walk < 0.999 || anim.air > 0.001 || drop > 0 || step > 0;
    // Toes turned out standing, less so walking.
    const toe = lerp(st.toe, 0.06, walk);
    // Standing: feet a little apart, the free one forward (x to the left, z ahead of the point under each hip).
    const standLx = crouch ? hx + 0.08 : hx + st.apart;
    const standLz = crouch ? 0.05 * s : st.support < 0 ? st.free : 0;
    const standRz = crouch ? 0.05 * s : st.support > 0 ? st.free : 0;
    // Setting off or stopping, one foot steps between the stride and its standing place, lifted on an arc as high as a
    // fifth of the way it goes (at most STEP_LIFT), while the other stays on the ground: the foot in the air when he
    // starts, or with both down the one with further to go, chosen once for the step. (By the rate the gait comes and
    // goes: a steady crawl, part walking and part standing, keeps its feet down.)
    const fl = g.legs[0]!.foot;
    const fr = g.legs[1]!.foot;
    const wayL = blend ? Math.hypot(fl.x - standLx, fl.z - standLz) : 0;
    const wayR = blend ? Math.hypot(fr.x + standLx, fr.z - standRz) : 0;
    const arc = clamp(anim.shift / 10, 0, 1) * 4 * walk * (1 - walk);
    if (!blend || anim.shift < STEP_SETTLED) anim.stepper = -1;
    else if (anim.stepper < 0) {
      const pl = g.legs[0]!.planted;
      const pr = g.legs[1]!.planted;
      anim.stepper = pl !== pr ? (pl ? 1 : 0) : wayL >= wayR ? 0 : 1;
    }
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const leg = g.legs[i]!;
      const slack = side !== st.support;
      const hipX = side * hx + shift;
      const legY = hipY - (slack ? sag : 0);
      if (blend) {
        const way = i === 0 ? wayL : wayR;
        const lift = i === anim.stepper ? Math.min(STEP_LIFT * s, 0.2 * way) * arc : 0;
        this.blendLeg(leg, side, hipX, legY, s, walk, anim.air, step, side * standLx, i === 0 ? standLz : standRz, lift);
      }
      // Hip frame (yaw only, origin on the ground under the hips) to world.
      const hip = (i === 0 ? S.hipL : S.hipR).set(c.pos.x + hc * hipX, c.pos.y + legY, c.pos.z - hs * hipX);
      const k = leg.knee;
      const f = leg.ankle;
      S.knee.set(c.pos.x + hc * k.x + hs * k.z, c.pos.y + k.y, c.pos.z - hs * k.x + hc * k.z);
      S.ankle.set(c.pos.x + hc * f.x + hs * f.z, c.pos.y + f.y, c.pos.z - hs * f.x + hc * f.z);
      this.leg(hip, S.knee, S.ankle, hipLeft, c);
      this.shoe(S.ankle, hipYaw + side * toe * (slack ? 0.6 : 1), leg.foot.pitch, s);
    }

    // Arms.
    const left = S.left;
    const up = S.up;
    const fwd = S.fwd;
    const pole = S.pole;
    const reach = (SKELETON.upperArm + SKELETON.forearm + SKELETON.hand) * s;
    let leftDone = false;
    let rightDone = false;
    if (armed) {
      const w = this.wp;
      const gun = w.weapon;
      // The muzzle kicks up about the grip (pistol) or the shoulder (long guns, launcher) and pushes back.
      const m = this.weaponMatrix(w, kick * gunKick(gun), gun === 'pistol' ? WEAPON_POINTS.pistol.grip : WEAPON_POINTS[gun].stock, KICK_BACK * kick);
      this.put(this.weaponPart(gun), m, 0xffffff);
      const grip = S.targetR.set(WEAPON_POINTS[gun].grip.x, WEAPON_POINTS[gun].grip.y, WEAPON_POINTS[gun].grip.z).applyMatrix4(m);
      pole.copy(up).negate().addScaledVector(left, w.mode === 'lowered' ? -0.4 : -0.8).addScaledVector(fwd, w.mode === 'lowered' ? -0.6 : -0.2);
      this.armTo(S.shR, grip, pole, left, c);
      rightDone = true;
      if (w.twoHands) {
        // Reloading, the off hand works the magazine or the pump.
        const work = w.mode === 'reload' ? 0.025 * Math.sin(this.time * 9) : 0;
        const off = S.targetL.set(w.offLocal.x, w.offLocal.y, w.offLocal.z + work).applyMatrix4(m);
        pole.copy(up).negate().addScaledVector(left, 0.7).addScaledVector(fwd, -0.2);
        this.armTo(S.shL, off, pole, left, c);
        leftDone = true;
      }
    } else if (fists) {
      // Guard up; punches alternate by combo: right jab, left jab, right hook with a twist and a step.
      for (const side of [1, -1]) {
        const sh = side > 0 ? S.shL : S.shR;
        const target = (side > 0 ? S.targetL : S.targetR).copy(sh).addScaledVector(fwd, (side > 0 ? 0.3 : 0.24) * s).addScaledVector(up, 0.1 * s).addScaledVector(left, -side * 0.13);
        const striking = punch > 0 && (combo === 1 ? side > 0 : side < 0);
        if (striking) {
          if (combo === 2) {
            // Hook: swings out wide, then across to the chin line with the elbow bent.
            S.d1.copy(sh).addScaledVector(fwd, 0.42 * s).addScaledVector(left, 0.12).addScaledVector(up, 0.05 * s);
            target.lerp(S.d1, punch).addScaledVector(left, -side * 0.22 * Math.sin(Math.PI * punch));
          } else {
            S.d1.copy(sh).addScaledVector(fwd, reach * 0.96).addScaledVector(left, -side * 0.06).addScaledVector(up, 0.02);
            target.lerp(S.d1, punch);
          }
        }
        pole.copy(up).negate().addScaledVector(left, side * 0.9).addScaledVector(fwd, -0.2);
        this.armTo(sh, target, pole, left, c);
        if (side < 0) {
          S.heldHand.copy(S.hand);
          S.heldElbow.copy(S.elbow);
        }
      }
      leftDone = rightDone = true;
    } else if (cower) {
      for (const side of [1, -1]) {
        const sh = side > 0 ? S.shL : S.shR;
        const target = side > 0 ? S.targetL : S.targetR;
        if (handsUp) {
          target.copy(sh).addScaledVector(up, 0.42 * s).addScaledVector(left, side * 0.14).addScaledVector(fwd, 0.08);
          pole.copy(left).multiplyScalar(side).addScaledVector(up, -0.4);
        } else {
          // Hands clasped over the back of the head.
          target.copy(S.neck).addScaledVector(up, 0.27 * s).addScaledVector(left, side * 0.08).addScaledVector(fwd, -0.02);
          pole.copy(fwd).addScaledVector(left, side * 0.8);
        }
        this.armTo(sh, target, pole, left, c);
      }
      leftDone = rightDone = true;
    } else if (entering) {
      // Reaching for the door handle.
      S.targetR.copy(S.shR).addScaledVector(fwd, 0.5 * s).addScaledVector(up, -0.15 * s).addScaledVector(left, 0.05);
      pole.copy(up).negate().addScaledVector(left, -0.4).addScaledVector(fwd, -0.3);
      this.armTo(S.shR, S.targetR, pole, left, c);
      rightDone = true;
    } else if (c.phoneTimer > 0 && !held) {
      // On the phone to the police: the right hand up at the ear, the phone in it.
      S.targetR.copy(S.neck).addScaledVector(up, 0.17 * s).addScaledVector(left, -0.11).addScaledVector(fwd, 0.03);
      pole.copy(up).negate().addScaledVector(left, -0.9).addScaledVector(fwd, 0.2);
      this.armTo(S.shR, S.targetR, pole, left, c);
      rightDone = true;
      S.inst.makeBasis(S.bx.copy(fwd), S.by.copy(up), S.bz.copy(left).negate()).setPosition(S.hand.x + left.x * 0.03, S.hand.y, S.hand.z + left.z * 0.03);
      this.put(this.phone, S.inst, 0x1c1c22);
    } else if (c.hailTimer > 0 && !held) {
      // Waving down a taxi (Character.hailTimer): the right arm up high, the hand waving from side to side.
      S.targetR.copy(S.shR).addScaledVector(up, 0.42 * s).addScaledVector(fwd, 0.16 * s).addScaledVector(left, -0.1 + 0.06 * Math.sin(this.time * 7 + c.id));
      pole.copy(left).negate().addScaledVector(up, -0.4);
      this.armTo(S.shR, S.targetR, pole, left, c);
      rightDone = true;
    }
    // Free arms swing with the gait, and go out for balance in the air. Standing they hang plumb (against his lean)
    // with the elbows a little bent, the hands a touch forward of the thighs.
    const air = anim.air;
    for (let i = 0; i < 2; i++) {
      if (i === 0 ? leftDone : rightDone) continue;
      const sw = g.arms[i]!;
      const pitch = lerp(lerp(-0.03 - lean, sw.pitch, walk), -0.8, air);
      const abduct = lerp(lerp(0.1, sw.abduct, walk), 0.55, air);
      const elbow = lerp(lerp(st.hang, sw.elbow, walk), 0.8, air);
      this.armFK(i === 0 ? S.shL : S.shR, i === 0 ? 1 : -1, pitch, abduct, elbow, lerp(0, sw.out, walk), c);
      if (i === 1) {
        S.heldHand.copy(S.hand);
        S.heldElbow.copy(S.elbow);
      }
    }
    if (held) this.heldItem(held, punch, S.heldHand, S.heldElbow, up, fwd);
  }

  /**
   * A bat, knife, grenade or molotov in the right hand: out of the fist along the forearm, a bat held up over the
   * shoulder that comes round forward with the swing (`swing` 0..1), a knife's blade forward.
   */
  private heldItem(id: WeaponId, swing: number, hand: THREE.Vector3, elbow: THREE.Vector3, up: THREE.Vector3, fwd: THREE.Vector3): void {
    const part = this.weapons.get(id);
    if (!part) return;
    const Y = S.by.subVectors(hand, elbow);
    if (Y.lengthSq() < 1e-10) Y.copy(up);
    Y.normalize();
    if (id === 'bat') Y.multiplyScalar(0.35).addScaledVector(up, 1 - swing).addScaledVector(fwd, 0.3 + 1.2 * swing).normalize();
    else if (id === 'knife') Y.addScaledVector(fwd, 0.9).normalize();
    else Y.addScaledVector(up, 0.6).normalize();
    const X = S.bx.copy(fwd).cross(Y);
    if (X.lengthSq() < 1e-8) X.set(1, 0, 0).cross(Y);
    X.normalize();
    const Z = S.bz.crossVectors(X, Y);
    S.inst.makeBasis(X, Y, Z).setPosition(hand);
    this.put(part, S.inst, HELD_COLOR[id] ?? 0x888888);
  }

  /**
   * Blends a gait leg towards a standing foot at (sx, sz) (hip frame), the airborne tuck and the hook's step, and
   * re-solves it from its hip joint at (hipX, hipY).
   */
  private blendLeg(leg: LegPose, side: number, hipX: number, hipY: number, s: number, walk: number, air: number, step: number, sx: number, sz: number, lift: number): void {
    const f = leg.foot;
    f.x = lerp(sx, f.x, walk);
    f.y = lerp(SKELETON.ankleY * s, f.y, walk);
    f.z = lerp(sz, f.z, walk) + (side > 0 ? step : 0);
    f.pitch = lerp(0, f.pitch, walk);
    f.y += lift;
    if (air > 0) {
      // Knees drawn up under the body.
      f.x = lerp(f.x, hipX, air);
      f.y = lerp(f.y, hipY - 0.5 * s, air);
      f.z = lerp(f.z, -0.08 * s, air);
      f.pitch = lerp(f.pitch, -0.45, air);
    }
    // Easing a foot rolled up on its toes or heel towards a flat one can tip that edge under the ground: lift it back.
    const low = soleLow(f.y, f.pitch, s);
    if (low < 0) f.y -= low;
    solveLeg(hipX, hipY, s, leg);
  }

  /** Knocked down, dead, or getting back up: on the back, limbs posed by angle. */
  private lying(c: Character, lie: number): void {
    const s = c.appearance.height;
    const bw = c.appearance.build;
    const dead = c.state === 'dead';
    const knocked = c.state === 'knocked';
    const ph = c.animPhase;
    // The hips tip over backwards onto the back as `lie` goes 0 -> 1.
    S.rot.makeRotationY(c.heading);
    const P = S.pelvis.set(0, SKELETON.hipY * s * (1 - lie) + 0.16 * lie, -0.5 * lie).applyMatrix4(S.rot).add(c.pos);
    S.body.copy(S.rot).multiply(S.rot2.makeRotationX((-Math.PI / 2) * lie));
    this.torso(c, P, dead ? 0.3 * (seeded(c.id, 1) - 0.5) : -0.25);
    this.shoulders(c, P);
    const hx = hipSpread(bw);
    for (const side of [1, -1]) {
      const sh = side > 0 ? S.shL : S.shR;
      const hip = (side > 0 ? S.hipL : S.hipR).copy(P).addScaledVector(S.left, side * hx);
      if (dead) {
        // Relaxed: arms a little out from the body, elbows slightly bent, legs together with a knee bend.
        const out = 0.25 + 0.5 * seeded(c.id, side > 0 ? 2 : 3);
        this.armFK(sh, side, 0.18, out, 0, -0.15 - 0.35 * seeded(c.id, side > 0 ? 4 : 5), c);
        const k = 0.25 + 0.45 * seeded(c.id, side > 0 ? 6 : 7);
        this.legFK(hip, side, -k * 0.55, 0.03 + 0.06 * seeded(c.id, side > 0 ? 8 : 9), k, -0.35, c);
      } else if (knocked) {
        // Bracing against the ground and kicking.
        this.armFK(sh, side, 0.35, 0.95 + 0.15 * Math.sin(ph * 2 + side), 0, 1.4, c);
        const kick = Math.sin(ph * 2 + side * 1.3) * 0.25;
        this.legFK(hip, side, -0.75 + kick, 0.08, 1.15 - kick, -0.1, c);
      } else {
        // Getting up: legs drawn in and arms pushing off, straightening as the body comes upright.
        this.armFK(sh, side, -0.6 * lie, lerp(0.09, 0.35, lie), lerp(0.18, 0.6, lie), 0, c);
        this.legFK(hip, side, -1.3 * lie, lerp(0.02, 0.12, lie), 1.9 * lie, 0, c);
      }
    }
  }

  /** Shares the sea's wave uniforms, so swimmers ride the waves the sea draws. */
  bindSea(u: SeaWaveUniforms): void {
    this.sea = u;
  }

  /**
   * Swimming face down: crawl strokes and a flutter kick, or treading water when still, riding the drawn sea's swell
   * (the sim's swimmer floats at the flat sea's level). A swimmer with a gun up treads water holding it out of the water
   * in his right hand, as sim/pose.ts places it (shots leave from its barrel, lifted with him by the renderer).
   */
  private swim(c: Character): void {
    const bw = c.appearance.build;
    const weapon = c.inventory.current;
    const shooting = isGun(weapon) && (c.aiming || c.shotTimer > 0);
    const moving = c.speed > 0.3 && !shooting;
    const ph = moving ? c.animPhase : this.time * 3 + c.id;
    const lift = seaHeightAt(this.sea, c.pos.x, c.pos.z);
    S.rot.makeRotationY(c.heading);
    const P = S.pelvis.set(0, SWIM_HIP + lift, 0).applyMatrix4(S.rot).add(c.pos);
    S.body.copy(S.rot).multiply(S.rot2.makeRotationX(moving ? 1.25 : SWIM_TREAD_LEAN));
    this.torso(c, P, moving ? -0.9 : -0.3);
    this.shoulders(c, P);
    if (shooting) {
      const w = weaponPoseInto(c, this.wp);
      const gun = w.weapon;
      const kick = this.kickOf(c);
      const m = this.weaponMatrix(w, kick * gunKick(gun), WEAPON_POINTS[gun].grip, KICK_BACK * kick);
      m.elements[13]! += lift;
      this.put(this.weaponPart(gun), m, 0xffffff);
      const g = WEAPON_POINTS[gun].grip;
      S.pole.copy(S.up).negate().addScaledVector(S.left, -0.6);
      this.armTo(S.shR, S.targetR.set(g.x, g.y, g.z).applyMatrix4(m), S.pole, S.left, c);
    }
    const hx = hipSpread(bw);
    for (const side of [1, -1]) {
      const sh = side > 0 ? S.shL : S.shR;
      const hip = (side > 0 ? S.hipL : S.hipR).copy(P).addScaledVector(S.left, side * hx);
      if (shooting && side < 0) {
        // The gun arm is drawn above; the legs still tread water.
        this.legFK(hip, side, -0.5 + 0.35 * Math.sin(ph * 0.8 + side), 0.1, 0.9, -0.3, c);
        continue;
      }
      if (moving) {
        // Crawl: each arm circles overhead, half a stroke apart; the elbow bends on the pull.
        const arm = ph * 0.45 + (side > 0 ? 0 : Math.PI);
        const round = Math.PI * 2;
        this.armFK(sh, side, -(((arm % round) + round) % round), 0.25, 0.5 * Math.max(0, Math.sin(arm)), 0, c);
        const k = ph * 1.2 + side * 1.5;
        this.legFK(hip, side, Math.sin(k) * 0.35, 0.05, 0.25 + 0.15 * Math.sin(k + 1), -1.2, c);
      } else {
        // Treading water: arms sculling at the sides, legs cycling.
        const sc = Math.sin(ph + (side > 0 ? 0 : 1));
        this.armFK(sh, side, -0.5, 0.9 + 0.25 * sc, 0.6, 0, c);
        this.legFK(hip, side, -0.5 + 0.35 * Math.sin(ph * 0.8 + side), 0.1, 0.9, -0.3, c);
      }
    }
  }

  /** Height a vehicle kind's view is rotated about: half the model's height, measured as VehicleView does. */
  private pivotY(kind: VehicleKind): number {
    let p = this.pivots.get(kind);
    if (p === undefined) {
      p = new THREE.Box3().setFromObject(new VehicleView(kind).group).max.y / 2;
      this.pivots.set(kind, p);
    }
    return p;
  }

  /**
   * `v`'s body frame as drawn (VehicleView: heading, pitch, roll, the body's lean, a wreck's sag), into S.frame; for a
   * vehicle no view draws, the same frame without the lean, from the simulation (YXZ about the body centre).
   */
  private vehicleFrame(v: Vehicle): THREE.Matrix4 {
    const drawn = drawnFrame(v);
    if (drawn) return S.frame.copy(drawn);
    const pivot = this.pivotY(v.kind);
    S.e.set(-v.pitch, v.heading, v.roll, 'YXZ');
    S.frame.makeRotationFromEuler(S.e);
    const c = S.d1.set(0, pivot, 0).applyMatrix4(S.frame);
    return S.frame.setPosition(v.pos.x - c.x, v.pos.y + pivot - c.y, v.pos.z - c.z);
  }

  /**
   * A driver or passenger in his seat (see cabinLayout and riderSeat: shoulders over the waistline, head under the roof
   * and in front of the low seat back), carried by the car body as drawn; the driver's hands on the wheel the car draws.
   */
  private seated(c: Character, v: Vehicle): void {
    if (v.spec.class !== 'car') {
      this.riding(c, v);
      return;
    }
    const layout = cabinLayout(v.kind);
    const weapon = c.inventory.current;
    const shooting = isGun(weapon) && c.shotTimer > 0;
    const side = seatSide(c.seat);
    if (!layout) {
      // Nobody shows through the dark windows of a van, a riot van or a bus: only a gun held out of one, and the arm
      // holding it.
      if (shooting) this.windowGun(c, v, weapon as Gun, null, side);
      return;
    }
    const a = c.appearance;
    const s = a.height;
    const bw = a.build;
    const seat = riderSeat(layout, c.seat >= 2, s, a.hat !== 0, this.seat);
    const frame = this.vehicleFrame(v);
    const vrot = S.vrot.extractRotation(frame);
    const P = S.pelvis.set(side * v.halfW * 0.45, seat.y, seat.z).applyMatrix4(frame);
    S.vleft.set(1, 0, 0).transformDirection(vrot);
    S.vup.set(0, 1, 0).transformDirection(vrot);
    S.vfwd.set(0, 0, 1).transformDirection(vrot);
    // Leaning back against the seat, head tipped forward to look ahead.
    S.body.copy(vrot).multiply(S.rot2.makeRotationX(-seat.recline));
    this.torso(c, P, seat.recline * 0.8);
    this.shoulders(c, P);
    // Thighs along the seat, under the waistline; shins and shoes are down in the footwell, out of sight.
    const hx = hipSpread(bw);
    for (const sd of [1, -1]) {
      const hip = (sd > 0 ? S.hipL : S.hipR).copy(P).addScaledVector(S.vleft, sd * hx);
      S.knee.copy(hip).addScaledVector(S.vfwd, SKELETON.thigh * s).addScaledVector(S.vup, 0.04 * s).addScaledVector(S.vleft, sd * 0.03);
      this.leg(hip, S.knee, null, S.vleft, c);
    }
    const pole = S.pole;
    let busy = 0;
    if (shooting) {
      // Drive-by: the gun held out of the shooter's own window.
      busy = side;
      this.windowGun(c, v, weapon as Gun, side > 0 ? S.shL : S.shR, side);
    }
    const w = layout.wheel;
    for (const sd of [1, -1]) {
      if (sd === busy) continue;
      const target = sd > 0 ? S.targetL : S.targetR;
      if (c.seat === 0) {
        // Hands on the rim at a quarter to three, turned with the steering (clockwise for a right turn): the rim's
        // across axis is the car's x, its up axis is tilted forward by the wheel's tilt.
        const turn = clamp(v.steer, -1, 1) * WHEEL_LOCK;
        const across = sd * w.radius * Math.cos(turn);
        const up = sd * w.radius * Math.sin(turn);
        target.set(w.x + across, w.y + up * Math.cos(w.tilt), w.z + up * Math.sin(w.tilt)).applyMatrix4(frame);
        pole.copy(S.vup).negate().addScaledVector(S.vleft, sd * 0.6);
      } else {
        // Hands resting in the lap.
        target.set(sd * 0.11, 0.1 * s, 0.26 * s).applyMatrix4(vrot).add(P);
        pole.copy(S.vfwd).multiplyScalar(-0.4).addScaledVector(S.vleft, sd * 0.4).sub(S.vup);
      }
      this.armTo(sd > 0 ? S.shL : S.shR, target, pole, S.left, c);
    }
  }

  /**
   * A rider on a bike or a boat, on the seat its view publishes (riders.ts): hips on the seat, the torso tilted as the
   * seat says, the hands on the bars, wheel or tiller and the soles on the pegs or the deck, all carried by the body as
   * drawn (a bike's lean and wheelie). A shooter holds his gun out to his side instead of the grip on that side.
   */
  private riding(c: Character, v: Vehicle): void {
    const mount = riderMount(v);
    if (!mount || mount.seats.length === 0) return;
    const seat = mount.seats[Math.min(c.seat, mount.seats.length - 1)]!;
    const a = c.appearance;
    const s = a.height;
    const frame = S.frame.copy(mount.frame.matrixWorld);
    const vrot = S.vrot.extractRotation(frame);
    S.vleft.set(1, 0, 0).transformDirection(vrot);
    S.vup.set(0, 1, 0).transformDirection(vrot);
    S.vfwd.set(0, 0, 1).transformDirection(vrot);
    const P = S.pelvis.set(seat.hip.x, seat.hip.y, seat.hip.z).applyMatrix4(frame);
    S.body.copy(vrot).multiply(S.rot2.makeRotationX(-seat.recline));
    // Leaning forward over the bars he lifts his head to look ahead; leaning back he tips it forward.
    this.torso(c, P, seat.recline * 0.85);
    this.shoulders(c, P);
    const hx = hipSpread(a.build);
    for (const sd of [1, -1] as const) {
      const hip = (sd > 0 ? S.hipL : S.hipR).copy(P).addScaledVector(S.vleft, sd * hx);
      const f = seat.feet[sd > 0 ? 0 : 1];
      const foot = S.ankle.set(f.x, f.y + SKELETON.ankleY * s, f.z).applyMatrix4(frame);
      S.pole.copy(S.vfwd).addScaledVector(S.vleft, sd * 0.35);
      solveTwoBone(hip.x, hip.y, hip.z, foot.x, foot.y, foot.z, SKELETON.thigh * s, SKELETON.shin * s, S.pole.x, S.pole.y, S.pole.z, ik);
      S.knee.set(ik.mx, ik.my, ik.mz);
      const ankle = S.wrist.set(ik.ex, ik.ey, ik.ez);
      this.leg(hip, S.knee, ankle, S.vleft, c);
      S.inst.copy(vrot).scale(S.sc.set(1, s, s)).setPosition(ankle);
      this.put(this.parts.shoe, S.inst, 0xffffff);
    }
    const weapon = c.inventory.current;
    const side = seatSide(c.seat);
    let busy = 0;
    if (weapon !== 'fists' && c.shotTimer > 0) {
      busy = side;
      this.windowGun(c, v, weapon, side > 0 ? S.shL : S.shR, side);
    }
    for (const sd of [1, -1] as const) {
      if (sd === busy) continue;
      const h = seat.hands[sd > 0 ? 0 : 1];
      const target = (sd > 0 ? S.targetL : S.targetR).set(h.x, h.y, h.z).applyMatrix4(frame);
      S.pole.copy(S.vup).negate().addScaledVector(S.vleft, sd * 0.6).addScaledVector(S.vfwd, -0.3);
      this.armTo(sd > 0 ? S.shL : S.shR, target, S.pole, S.left, c);
    }
  }

  /**
   * A seated shooter's gun out of his own window, pointing along his aim (which CombatSystem.npcFire publishes for NPCs),
   * its barrel end on the point his shots leave from (sim/pose.ts windowMuzzle: his seat's window, as
   * CombatSystem.muzzle(c, true) fires), moved with a boat's hull as it is drawn on the swell (riders.ts onDrawn): the gun
   * stays there and the hand reaches for its grip as far as the arm goes.
   * With no shoulder (nobody is drawn behind dark windows), his arm reaches out to the grip from inside the window.
   */
  private windowGun(c: Character, v: Vehicle, gun: Gun, shoulder: THREE.Vector3 | null, side: number): void {
    const w = this.wp;
    const pts = WEAPON_POINTS[gun];
    w.weapon = gun;
    aimFrame(w, c.aimYaw, clamp(c.aimPitch, -1.2, 1.2), 0);
    // On a boat the sim's window floats on a flat sea: the gun goes with the hull as drawn on the swell, in his hand.
    const m = onDrawn(v, windowMuzzle(v, c.seat, this.muzzle));
    anchor(w, pts.tip, m.x, m.y, m.z);
    const grip = weaponPoint(w, pts.grip, S.targetL);
    if (shoulder) {
      S.pole.copy(S.up).negate().addScaledVector(S.left, side * 0.5);
      this.armTo(shoulder, S.d1.set(grip.x, grip.y, grip.z), S.pole, S.left, c);
    } else {
      // A shoulder inside the body, in from the grip across the car and a little lower: the upper arm stays behind the
      // dark window, the forearm and the hand show where they reach out of it.
      const s = c.appearance.height;
      const lx = Math.cos(v.heading);
      const lz = -Math.sin(v.heading);
      S.vleft.set(lx, 0, lz);
      S.shR.set(grip.x - lx * side * 0.42 * s, grip.y - 0.15 * s, grip.z - lz * side * 0.42 * s);
      S.pole.set(0, -1, 0).addScaledVector(S.vleft, side * 0.3);
      this.armTo(S.shR, S.d1.set(grip.x, grip.y, grip.z), S.pole, S.vleft, c);
    }
    const kick = this.kickOf(c);
    this.put(this.weaponPart(gun), this.weaponMatrix(w, kick * gunKick(gun), pts.grip, KICK_BACK * kick), 0xffffff);
  }
}
