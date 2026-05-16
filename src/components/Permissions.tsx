import { useEffect, useState } from "react";
import { native, type PermissionsStatus } from "../lib/native";

const ACCENT = "var(--accent)";
const ACCENT_SHADOW = "var(--accent-shadow)";

function PermRow({
  title,
  description,
  granted,
  onAllow,
  buttonLabel,
}: {
  title: string;
  description: string;
  granted: boolean;
  onAllow: () => void;
  buttonLabel: string;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 24,
        alignItems: "center",
        padding: "20px 0",
        borderTop: "0.5px solid rgba(255,255,255,0.08)",
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "rgba(255,255,255,0.95)", marginBottom: 6 }}>
          {title}
        </div>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)", lineHeight: 1.45, maxWidth: 360 }}>
          {description}
        </div>
      </div>
      <button
        onClick={onAllow}
        disabled={granted}
        style={{
          minWidth: 220,
          padding: "12px 20px",
          borderRadius: 10,
          background: granted ? "rgba(48,209,88,0.14)" : "rgba(0,0,0,0.4)",
          border: granted ? "0.5px solid rgba(48,209,88,0.4)" : "0.5px solid rgba(255,255,255,0.1)",
          color: granted ? "#30D158" : ACCENT,
          fontSize: 14,
          fontWeight: 600,
          cursor: granted ? "default" : "pointer",
        }}
      >
        {granted ? "✓ Granted" : buttonLabel}
      </button>
    </div>
  );
}

export function Permissions() {
  const [status, setStatus] = useState<PermissionsStatus>({
    screenRecording: false,
    accessibility: false,
  });

  // Poll permissions every 1.5s so the UI flips to Granted when the user
  // enables it in System Settings without restarting the app.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      native.checkPermissions().then((s) => {
        if (alive) setStatus(s);
      });
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const allDone = status.screenRecording && status.accessibility;
  const canContinue = allDone;

  const handleContinue = async () => {
    if (!canContinue) return;
    await native.dismissPermissions();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#0a0a0c",
        color: "white",
        fontFamily: "var(--font-sans)",
        display: "flex",
        justifyContent: "center",
        padding: "40px 56px",
        overflowY: "auto",
      }}
      data-tauri-drag-region
    >
      <div style={{ width: "100%", maxWidth: 600, paddingTop: 60 }}>
        {/* Logo */}
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 28 }}>
          <img
            src="/logo.png"
            alt="OpenScreen Studio"
            width={88}
            height={88}
            style={{ filter: `drop-shadow(0 0 40px ${ACCENT_SHADOW})` }}
          />
        </div>

        <h1
          style={{
            margin: 0,
            fontSize: 28,
            fontWeight: 700,
            textAlign: "center",
            letterSpacing: -0.4,
          }}
        >
          Welcome to OpenScreen Studio!
        </h1>
        <p
          style={{
            margin: "10px 0 36px",
            fontSize: 14,
            color: "rgba(255,255,255,0.55)",
            textAlign: "center",
          }}
        >
          Before you can start recording, we need to ask you for a few permissions.
        </p>

        <PermRow
          title="Screen Recording Permission"
          description="OpenScreen Studio needs to capture video of your screen. You may need to enable it in System Settings → Privacy & Security → Screen Recording."
          granted={status.screenRecording}
          onAllow={() => native.requestScreenRecording().then((ok) => setStatus((s) => ({ ...s, screenRecording: ok })))}
          buttonLabel="Allow Screen Recording"
        />
        <PermRow
          title="Accessibility Permission"
          description="OpenScreen Studio needs to capture mouse movements and shortcut keystrokes while you are recording your screen."
          granted={status.accessibility}
          onAllow={() => native.requestAccessibility().then((ok) => setStatus((s) => ({ ...s, accessibility: ok })))}
          buttonLabel="Allow Accessibility access"
        />

        <div style={{ display: "flex", justifyContent: "center", marginTop: 32 }}>
          <button
            onClick={handleContinue}
            disabled={!canContinue}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 24px",
              borderRadius: 10,
              background: canContinue ? ACCENT : "rgba(255,255,255,0.08)",
              color: canContinue ? "white" : "rgba(255,255,255,0.4)",
              border: 0,
              fontSize: 14,
              fontWeight: 600,
              cursor: canContinue ? "pointer" : "not-allowed",
              boxShadow: canContinue ? `0 6px 20px ${ACCENT_SHADOW}` : "none",
            }}
          >
            <span
              style={{
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: canContinue ? "white" : "rgba(255,255,255,0.15)",
                color: canContinue ? ACCENT : "transparent",
                fontSize: 11,
                fontWeight: 900,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ✓
            </span>
            Accept and Continue
          </button>
        </div>
      </div>
    </div>
  );
}
