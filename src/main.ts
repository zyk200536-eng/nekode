import "./style.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Pet, Bubble, type PetEvent, type SkinInfo } from "./pet";

const isBubble = getCurrentWindow().label === "bubble";
const isSettings = getCurrentWindow().label === "settings";
document.body.classList.add(
  isBubble ? "win-bubble" : isSettings ? "win-settings" : "win-pet",
);

if (isBubble) {
  const bubble = new Bubble(
    document.getElementById("bubble")!,
    document.getElementById("bubble-text")!,
  );
  listen<PetEvent>("pet-event", (e) => bubble.handleEvent(e.payload));
  listen("pet-demo", () => bubble.demo());
  invoke<{ bubbleSeconds: number }>("get_state")
    .then((s) => bubble.setBubbleSeconds(s.bubbleSeconds))
    .catch(() => {});
  listen<{ bubbleSeconds: number }>("config-changed", (e) =>
    bubble.setBubbleSeconds(e.payload.bubbleSeconds),
  );
} else if (isSettings) {
  await import("./settings");
} else {
  const canvas = document.getElementById("pet") as HTMLCanvasElement;
  const pet = new Pet(canvas);

  (async () => {
    const state = await invoke<{ skin: string }>("get_state").catch(() => null);
    const ok = state ? await pet.loadSkin(state.skin) : false;
    if (!ok) await pet.loadBundled();
    pet.start();
  })();

  listen<SkinInfo>("skin-changed", async (e) => {
    const ok = await pet.loadSkin(e.payload.name);
    if (!ok) await pet.loadBundled();
  });

  listen<PetEvent>("pet-event", (e) => pet.handleEvent(e.payload));
  listen("pet-demo", () => pet.demo());

  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 0) {
      getCurrentWindow()
        .startDragging()
        .catch(() => {});
    }
  });

  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    invoke("show_ctx_menu").catch(() => {});
  });
}
