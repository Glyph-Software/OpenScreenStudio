// WebGL2 compositor: GPU implementation of lib/compositor's renderFrame().
// All geometry/zoom/cursor/motion-blur *math* stays in lib/compositor (shared
// with the Canvas2D path and the DOM preview); this file only rasterizes.
//
// Layer order matches renderFrame(): wallpaper → video passes (motion blur as
// N alpha-averaged samples) → cursor glyph → camera bubble. The rounded-rect
// window clip is evaluated per-fragment as a signed-distance field in zoom
// space, exactly where Canvas2D applies ctx.clip().
//
// Callers must use same-origin (blob:) media sources — uploading an
// asset-protocol <video> to a texture throws a SecurityError in WKWebView.
// render() lets that propagate so callers can fall back to the 2D/DOM path.

import type { CursorSidecarShapeName } from "./native";
import {
  computeCursorSprite,
  computeVideoPasses,
  computeVideoPlacement,
  CURSOR_GLYPHS,
  glyphFor,
  RADIUS_LG,
  renderWallpaperToCanvas,
  zoomTransformAt,
  type RenderFrameOpts,
  type ZoomTransform,
} from "./compositor";

// ---------------------------------------------------------------------------
// Small affine helpers (canvas-style {a,b,c,d,e,f}: x' = a·x + c·y + e)
// ---------------------------------------------------------------------------

type Affine = { a: number; b: number; c: number; d: number; e: number; f: number };

const AFF_I: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const tr = (e: number, f: number): Affine => ({ a: 1, b: 0, c: 0, d: 1, e, f });
const sc = (a: number, d: number): Affine => ({ a, b: 0, c: 0, d, e: 0, f: 0 });

/** outer ∘ inner: maps p → outer(inner(p)). */
function mul(o: Affine, i: Affine): Affine {
  return {
    a: o.a * i.a + o.c * i.b,
    b: o.b * i.a + o.d * i.b,
    c: o.a * i.c + o.c * i.d,
    d: o.b * i.c + o.d * i.d,
    e: o.a * i.e + o.c * i.f + o.e,
    f: o.b * i.e + o.d * i.f + o.f,
  };
}

function inv(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;
  const id = det !== 0 ? 1 / det : 0;
  const a = m.d * id;
  const b = -m.b * id;
  const c = -m.c * id;
  const d = m.a * id;
  return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}

function toMat3(m: Affine, out: Float32Array): Float32Array {
  out[0] = m.a;
  out[1] = m.b;
  out[2] = 0;
  out[3] = m.c;
  out[4] = m.d;
  out[5] = 0;
  out[6] = m.e;
  out[7] = m.f;
  out[8] = 1;
  return out;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const VS = `#version 300 es
layout(location = 0) in vec2 aPos; // unit quad, 0..1
uniform mat3 uXf;       // unit quad -> output px
uniform mat3 uClipXf;   // output px -> clip-local px
uniform vec2 uViewport;
uniform vec4 uSrcRect;  // (u0, v0, u1, v1)
out vec2 vUv;
out vec2 vClipPos;
void main() {
  vec3 p = uXf * vec3(aPos, 1.0);
  vUv = mix(uSrcRect.xy, uSrcRect.zw, aPos);
  vClipPos = (uClipXf * vec3(p.xy, 1.0)).xy;
  vec2 ndc = vec2(p.x / uViewport.x * 2.0 - 1.0, 1.0 - p.y / uViewport.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform int uMode;        // 0 = textured, 1 = solid rounded-rect (shadow)
uniform float uAlpha;
uniform vec4 uColor;      // premultiplied, mode 1
uniform vec4 uClipRect;   // x,y,w,h in clip-local px; w <= 0 disables clipping
uniform float uClipRadius;
uniform float uClipScale; // screen px per clip-local px (AA width)
uniform float uShadowBlur;
in vec2 vUv;
in vec2 vClipPos;
out vec4 frag;

float rrect(vec2 p, vec2 c, vec2 half_, float r) {
  vec2 q = abs(p - c) - (half_ - vec2(r));
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  float cov = 1.0;
  if (uClipRect.z > 0.0) {
    float d = rrect(vClipPos, uClipRect.xy + uClipRect.zw * 0.5,
                    uClipRect.zw * 0.5, uClipRadius);
    if (uShadowBlur > 0.0) {
      cov = 1.0 - smoothstep(-uShadowBlur, uShadowBlur, d);
    } else {
      cov = clamp(0.5 - d * uClipScale, 0.0, 1.0);
    }
  }
  vec4 c = (uMode == 1) ? uColor : texture(uTex, vUv);
  frag = c * (uAlpha * cov);
}`;

// ---------------------------------------------------------------------------
// Cursor glyph textures (shadow baked in, since GL has no ctx.shadowBlur)
// ---------------------------------------------------------------------------

/** Glyph drawn at GLYPH_BASE px inside a square padded by GLYPH_PAD per side. */
const GLYPH_BASE = 96;
const GLYPH_PAD = 24;

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to rasterize cursor glyph"));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

/**
 * Rasterize cursor glyphs with the drop shadow baked in (Canvas2D draws the
 * shadow live with ctx.shadow*; GL bakes it into the texture instead). The
 * shadow params mirror drawCursor's 2·s blur / 1·s offset at the nominal
 * 24-layout-px cursor size.
 */
export async function rasterizeGlyphsGL(): Promise<
  Map<CursorSidecarShapeName, HTMLCanvasElement>
> {
  const out = new Map<CursorSidecarShapeName, HTMLCanvasElement>();
  const shapes = Object.keys(CURSOR_GLYPHS) as CursorSidecarShapeName[];
  if (!shapes.includes("arrow")) shapes.push("arrow");
  const k = GLYPH_BASE / 24; // texture px per glyph viewBox unit
  for (const shape of shapes) {
    const g = glyphFor(shape);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${GLYPH_BASE}" height="${GLYPH_BASE}" style="overflow:visible">${g.svg}</svg>`;
    const img = await loadSvgImage(svg);
    const c = document.createElement("canvas");
    c.width = c.height = GLYPH_BASE + 2 * GLYPH_PAD;
    const cx = c.getContext("2d");
    if (!cx) throw new Error("Could not create glyph canvas context");
    cx.shadowColor = "rgba(0,0,0,0.45)";
    cx.shadowBlur = 2 * k;
    cx.shadowOffsetY = 1 * k;
    cx.drawImage(img, GLYPH_PAD, GLYPH_PAD, GLYPH_BASE, GLYPH_BASE);
    out.set(shape, c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// GLCompositor
// ---------------------------------------------------------------------------

export type GLRenderExtras = {
  /** Skip the wallpaper layer (preview draws it as DOM/CSS). */
  drawWallpaper?: boolean;
  /** Skip the camera bubble (preview keeps the interactive DOM overlay). */
  drawCamera?: boolean;
};

type Uniforms = {
  uXf: WebGLUniformLocation;
  uClipXf: WebGLUniformLocation;
  uViewport: WebGLUniformLocation;
  uSrcRect: WebGLUniformLocation;
  uTex: WebGLUniformLocation;
  uMode: WebGLUniformLocation;
  uAlpha: WebGLUniformLocation;
  uColor: WebGLUniformLocation;
  uClipRect: WebGLUniformLocation;
  uClipRadius: WebGLUniformLocation;
  uClipScale: WebGLUniformLocation;
  uShadowBlur: WebGLUniformLocation;
};

type DrawOpts = {
  xf: Affine;
  src?: [number, number, number, number];
  tex?: WebGLTexture;
  alpha?: number;
  clipXf?: Affine;
  clipRect?: [number, number, number, number];
  clipRadius?: number;
  clipScale?: number;
  shadow?: { color: [number, number, number, number]; blur: number };
};

export class GLCompositor {
  private gl: WebGL2RenderingContext;
  private uniforms: Uniforms;
  private videoTex: WebGLTexture;
  private cameraTex: WebGLTexture;
  private wallpaperTex: WebGLTexture | null = null;
  private wallpaperKey = "";
  private glyphTex = new Map<CursorSidecarShapeName, WebGLTexture>();
  private glyphSources: Map<CursorSidecarShapeName, HTMLCanvasElement> | null =
    null;
  private mat3Scratch = new Float32Array(9);

  static create(canvas: HTMLCanvasElement): GLCompositor | null {
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl2", {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        // Lets canvas.toBlob()/readPixels() snapshot after the rAF/task ends.
        preserveDrawingBuffer: true,
      });
    } catch {
      return null;
    }
    if (!gl) return null;
    try {
      return new GLCompositor(gl);
    } catch {
      return null;
    }
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const program = this.buildProgram(VS, FS);
    gl.useProgram(program);
    const u = (name: string) => {
      const loc = gl.getUniformLocation(program, name);
      if (!loc) throw new Error(`Missing uniform ${name}`);
      return loc;
    };
    this.uniforms = {
      uXf: u("uXf"),
      uClipXf: u("uClipXf"),
      uViewport: u("uViewport"),
      uSrcRect: u("uSrcRect"),
      uTex: u("uTex"),
      uMode: u("uMode"),
      uAlpha: u("uAlpha"),
      uColor: u("uColor"),
      uClipRect: u("uClipRect"),
      uClipRadius: u("uClipRadius"),
      uClipScale: u("uClipScale"),
      uShadowBlur: u("uShadowBlur"),
    };
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(this.uniforms.uTex, 0);
    this.videoTex = this.makeTexture();
    this.cameraTex = this.makeTexture();
  }

  private buildProgram(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type);
      if (!sh) throw new Error("createShader failed");
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(sh) ?? "shader compile failed");
      }
      return sh;
    };
    const prog = gl.createProgram();
    if (!prog) throw new Error("createProgram failed");
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) ?? "program link failed");
    }
    return prog;
  }

  private makeTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("createTexture failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private upload(
    tex: WebGLTexture,
    src: TexImageSource,
    premultiply: boolean,
  ) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  /** Provide pre-rasterized glyph canvases (see rasterizeGlyphsGL). */
  setGlyphs(glyphs: Map<CursorSidecarShapeName, HTMLCanvasElement>) {
    this.glyphSources = glyphs;
    for (const tex of this.glyphTex.values()) this.gl.deleteTexture(tex);
    this.glyphTex.clear();
  }

  private glyphTexture(shape: CursorSidecarShapeName): WebGLTexture | null {
    const cached = this.glyphTex.get(shape);
    if (cached) return cached;
    const src =
      this.glyphSources?.get(shape) ?? this.glyphSources?.get("arrow");
    if (!src) return null;
    const tex = this.makeTexture();
    this.upload(tex, src, true);
    this.glyphTex.set(shape, tex);
    return tex;
  }

  private draw(d: DrawOpts) {
    const gl = this.gl;
    const u = this.uniforms;
    gl.uniformMatrix3fv(u.uXf, false, toMat3(d.xf, this.mat3Scratch));
    gl.uniformMatrix3fv(
      u.uClipXf,
      false,
      toMat3(d.clipXf ?? AFF_I, this.mat3Scratch),
    );
    const src = d.src ?? [0, 0, 1, 1];
    gl.uniform4f(u.uSrcRect, src[0], src[1], src[2], src[3]);
    gl.uniform1f(u.uAlpha, d.alpha ?? 1);
    const clip = d.clipRect ?? [0, 0, -1, -1];
    gl.uniform4f(u.uClipRect, clip[0], clip[1], clip[2], clip[3]);
    gl.uniform1f(u.uClipRadius, d.clipRadius ?? 0);
    gl.uniform1f(u.uClipScale, d.clipScale ?? 1);
    if (d.shadow) {
      const [r, g, b, a] = d.shadow.color;
      gl.uniform1i(u.uMode, 1);
      gl.uniform4f(u.uColor, r * a, g * a, b * a, a);
      gl.uniform1f(u.uShadowBlur, d.shadow.blur);
    } else {
      gl.uniform1i(u.uMode, 0);
      gl.uniform4f(u.uColor, 0, 0, 0, 0);
      gl.uniform1f(u.uShadowBlur, 0);
      gl.bindTexture(gl.TEXTURE_2D, d.tex ?? null);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** GPU mirror of compositor renderFrame(). Throws on cross-origin media. */
  render(o: RenderFrameOpts, extras: GLRenderExtras = {}) {
    const gl = this.gl;
    const { layout, s, outW, outH } = o;
    const canvas = gl.canvas as HTMLCanvasElement;
    if (canvas.width !== outW || canvas.height !== outH) {
      canvas.width = outW;
      canvas.height = outH;
    }
    gl.viewport(0, 0, outW, outH);
    gl.uniform2f(this.uniforms.uViewport, outW, outH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // 1. Wallpaper — static layer, baked once per (wallpaper, blur, size).
    if (extras.drawWallpaper !== false) {
      const key = `${o.wallpaper}|${o.blur}|${outW}x${outH}|${o.wallpaperImg ? 1 : 0}`;
      if (key !== this.wallpaperKey || !this.wallpaperTex) {
        const baked = renderWallpaperToCanvas({
          layoutW: layout.w,
          layoutH: layout.h,
          s,
          outW,
          outH,
          wallpaper: o.wallpaper,
          wallpaperImg: o.wallpaperImg,
          blur: o.blur,
        });
        this.wallpaperTex ??= this.makeTexture();
        this.upload(this.wallpaperTex, baked, false);
        this.wallpaperKey = key;
      }
      this.draw({ xf: sc(outW, outH), tex: this.wallpaperTex });
    }

    // 2. Recorded window: video passes (motion blur) + cursor, clipped to the
    //    rounded rect in zoom space — mirrors renderFrame's inZoomSpace().
    this.upload(this.videoTex, o.videoSource as TexImageSource, false);
    const place = computeVideoPlacement(o);
    const vnW = Math.max(1, o.videoNaturalSize.w);
    const vnH = Math.max(1, o.videoNaturalSize.h);
    const srcRect: [number, number, number, number] = [
      place.sx / vnW,
      place.sy / vnH,
      (place.sx + place.sw) / vnW,
      (place.sy + place.sh) / vnH,
    ];
    const rw = layout.wrapW * s;
    const rh = layout.wrapH * s;
    const rr = Math.min(RADIUS_LG * s, rw / 2, rh / 2);
    const zoomOuter = (zt: ZoomTransform): Affine =>
      mul(
        tr(layout.wrapX * s + zt.tx * s, layout.wrapY * s + zt.ty * s),
        sc(zt.scale, zt.scale),
      );
    const clipFor = (outer: Affine) => ({
      clipXf: inv(outer),
      clipRect: [0, 0, rw, rh] as [number, number, number, number],
      clipRadius: rr,
    });

    for (const pass of computeVideoPasses(o)) {
      const outer = zoomOuter(pass.zt);
      this.draw({
        xf: mul(
          outer,
          mul(tr(place.dX * s, place.dY * s), sc(place.dW * s, place.dH * s)),
        ),
        src: srcRect,
        tex: this.videoTex,
        alpha: pass.alpha,
        ...clipFor(outer),
        clipScale: pass.zt.scale,
      });
    }

    // 2b. Cursor glyph (shadow baked into the texture), final transform only.
    if (o.cursorSidecar) {
      const spr = computeCursorSprite(o);
      if (spr) {
        const tex = this.glyphTexture(spr.shape);
        if (tex) {
          const ztEnd = zoomTransformAt(o, o.timeMs);
          const outer = zoomOuter(ztEnd);
          const sizePx = spr.size * s;
          const quad = sizePx * ((GLYPH_BASE + 2 * GLYPH_PAD) / GLYPH_BASE);
          const padPx = (GLYPH_PAD / GLYPH_BASE) * sizePx;
          this.draw({
            xf: mul(
              outer,
              mul(
                tr(
                  (spr.x - spr.hot[0] * spr.size) * s - padPx,
                  (spr.y - spr.hot[1] * spr.size) * s - padPx,
                ),
                sc(quad, quad),
              ),
            ),
            tex,
            ...clipFor(outer),
            clipScale: ztEnd.scale,
          });
        }
      }
    }

    // 3. Camera bubble — frame space, unaffected by zoom.
    if (o.camera && extras.drawCamera !== false) {
      const cam = o.camera;
      const box = cam.size * outW;
      if (box >= 2) {
        const x = cam.pos.x * outW - box / 2;
        const y = cam.pos.y * outH - box / 2;
        const r = cam.shape === "circle" ? box / 2 : box * 0.18;
        const blur = 18 * s;
        const offY = 6 * s;
        // Drop shadow: solid rounded-rect SDF, offset down like ctx.shadow*.
        this.draw({
          xf: mul(
            tr(x - 2 * blur, y + offY - 2 * blur),
            sc(box + 4 * blur, box + 4 * blur),
          ),
          clipRect: [x, y + offY, box, box],
          clipRadius: r,
          shadow: { color: [0, 0, 0, 0.35], blur },
        });
        // Video, object-fit: cover, clipped to the bubble path.
        this.upload(this.cameraTex, cam.source as TexImageSource, false);
        const vw = Math.max(1, cam.naturalSize.w);
        const vh = Math.max(1, cam.naturalSize.h);
        const cover = Math.max(box / vw, box / vh);
        const dw = vw * cover;
        const dh = vh * cover;
        this.draw({
          xf: mul(tr(x + (box - dw) / 2, y + (box - dh) / 2), sc(dw, dh)),
          src: cam.mirrored ? [1, 0, 0, 1] : [0, 0, 1, 1],
          tex: this.cameraTex,
          clipRect: [x, y, box, box],
          clipRadius: r,
        });
      }
    }
  }

  /**
   * Read back the framebuffer as tightly-packed RGBA. Rows come out
   * bottom-up (GL convention) — the export encoder applies `vflip`.
   */
  readPixels(out?: Uint8Array): Uint8Array {
    const gl = this.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const buf = out && out.length === w * h * 4 ? out : new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  }

  /**
   * Free GPU resources. Only pass `loseContext: true` for throwaway
   * canvases (the exporter): a canvas that stays mounted would hand the
   * same — now permanently lost — context back to a later create() call.
   */
  dispose(opts: { loseContext?: boolean } = {}) {
    const gl = this.gl;
    gl.deleteTexture(this.videoTex);
    gl.deleteTexture(this.cameraTex);
    if (this.wallpaperTex) gl.deleteTexture(this.wallpaperTex);
    for (const tex of this.glyphTex.values()) gl.deleteTexture(tex);
    this.glyphTex.clear();
    if (opts.loseContext) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }
}
