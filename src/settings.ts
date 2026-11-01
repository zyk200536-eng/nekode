import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SkinInfo } from "./pet";

interface State {
  port: number;
  bubbleSeconds: number;
  skin: string;
  pushChannel: string;
  pushTarget: string;
}

const root = document.getElementById("settings-root")!;
root.classList.remove("hidden");

root.innerHTML = `
  <h1>agentpet 设置</h1>

  <section>
    <h2>皮肤</h2>
    <div id="skin-grid"></div>
  </section>

  <section>
    <h2>气泡</h2>
    <label class="row">
      <span>停留时长</span>
      <input id="bubble-range" type="range" min="1" max="15" step="1" />
      <b id="bubble-val"></b>
    </label>
  </section>

  <section>
    <h2>系统</h2>
    <label class="row">
      <span>开机自动启动</span>
      <input id="autostart" type="checkbox" />
    </label>
    <div class="row">
      <span>事件桥端口</span>
      <code id="port"></code>
      <button id="copy-test">复制测试命令</button>
    </div>
    <div class="row">
      <span>宠物位置</span>
      <button id="reset-pos">重置到屏幕右下角</button>
    </div>
    <div class="row">
      <span>Agent 接入</span>
      <button id="open-wizard">打开接入向导…</button>
    </div>
  </section>

  <section>
    <h2>手机推送</h2>
    <label class="row">
      <span>通道</span>
      <select id="push-channel">
        <option value="">关闭</option>
        <option value="ntfy">ntfy（安卓 / 网页）</option>
        <option value="bark">Bark（iOS）</option>
      </select>
    </label>
    <div class="row">
      <span>目标</span>
      <input id="push-target" type="text" placeholder="https://ntfy.sh/<topic> 或 Bark Key" />
      <button id="gen-topic">随机</button>
    </div>
    <p class="push-tip">topic 就是密码：点「随机」用随机串，别用可猜的词；手机端订阅同一 topic 即可接收。</p>
    <div class="row">
      <span>测试</span>
      <button id="push-test">发送测试推送</button>
      <span id="push-status"></span>
    </div>
  </section>

  <p class="tip">接入各 AI Agent 的配置说明见项目 integrations/README.md</p>
`;

const skinGrid = root.querySelector("#skin-grid") as HTMLDivElement;
const bubbleRange = root.querySelector("#bubble-range") as HTMLInputElement;
const bubbleVal = root.querySelector("#bubble-val") as HTMLElement;
const autostart = root.querySelector("#autostart") as HTMLInputElement;
const portEl = root.querySelector("#port") as HTMLElement;
const pushChannel = root.querySelector("#push-channel") as HTMLSelectElement;
const pushTarget = root.querySelector("#push-target") as HTMLInputElement;
const pushStatus = root.querySelector("#push-status") as HTMLElement;

function renderSkins(skins: SkinInfo[], current: string): void {
  skinGrid.innerHTML = "";
  for (const skin of skins) {
    const card = document.createElement("button");
    card.className = `skin-card${skin.name === current ? " active" : ""}`;
    card.title = skin.name;
    const img = document.createElement("img");
    img.alt = skin.name;
    img.style.imageRendering = skin.smooth ? "auto" : "pixelated";
    invoke<number[] | null>("read_sheet", { skin: skin.name, state: "idle" })
      .then((bytes) => {
        if (bytes && bytes.length) {
          const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
          img.src = URL.createObjectURL(blob);
        }
      })
      .catch(() => {});
    const label = document.createElement("span");
    label.textContent = skin.name;
    card.append(img, label);
    card.addEventListener("click", () => {
      invoke("set_config", { skin: skin.name }).catch(() => {});
    });
    skinGrid.append(card);
  }
}

(async () => {
  const state = await invoke<State>("get_state").catch(() => null);
  if (!state) return;
  portEl.textContent = String(state.port);
  bubbleRange.value = String(state.bubbleSeconds);
  bubbleVal.textContent = `${state.bubbleSeconds} 秒`;
  pushChannel.value = state.pushChannel ?? "";
  pushTarget.value = state.pushTarget ?? "";
  const skins = await invoke<SkinInfo[]>("list_skins").catch(() => []);
  renderSkins(skins, state.skin);

  autostart.checked = await invoke<boolean>("get_autostart").catch(() => false);
})();

bubbleRange.addEventListener("input", () => {
  bubbleVal.textContent = `${bubbleRange.value} 秒`;
});
bubbleRange.addEventListener("change", () => {
  invoke("set_config", { bubbleSeconds: Number(bubbleRange.value) }).catch(() => {});
});

autostart.addEventListener("change", () => {
  invoke("set_autostart", { enable: autostart.checked }).catch(() => {});
});

root.querySelector("#copy-test")?.addEventListener("click", (e) => {
  const cmd = `curl "http://127.0.0.1:${portEl.textContent}/e?agent=test&event=done&msg=hello"`;
  navigator.clipboard
    .writeText(cmd)
    .then(() => {
      const btn = e.target as HTMLButtonElement;
      btn.textContent = "已复制 ✓";
      window.setTimeout(() => (btn.textContent = "复制测试命令"), 1500);
    })
    .catch(() => {});
});

root.querySelector("#reset-pos")?.addEventListener("click", () => {
  invoke("reset_position").catch(() => {});
});

root.querySelector("#open-wizard")?.addEventListener("click", () => {
  invoke("open_wizard").catch(() => {});
});

// ---------- 手机推送 ----------

pushChannel.addEventListener("change", () => {
  invoke("set_config", { pushChannel: pushChannel.value }).catch(() => {});
});

pushTarget.addEventListener("change", () => {
  invoke("set_config", { pushTarget: pushTarget.value.trim() }).catch(() => {});
});

root.querySelector("#gen-topic")?.addEventListener("click", () => {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const topic = [...bytes].map((b) => chars[b % chars.length]).join("");
  pushTarget.value = topic;
  pushTarget.placeholder = "https://ntfy.sh/" + topic;
  invoke("set_config", { pushTarget: topic }).catch(() => {});
});

root.querySelector("#push-test")?.addEventListener("click", async (e) => {
  const btn = e.target as HTMLButtonElement;
  btn.disabled = true;
  pushStatus.textContent = "发送中…";
  try {
    await invoke("push_test", { channel: pushChannel.value, target: pushTarget.value.trim() });
    pushStatus.textContent = "✓ 已送达，看手机";
  } catch (err) {
    pushStatus.textContent = `✗ ${err}`;
  }
  btn.disabled = false;
});

listen<SkinInfo>("skin-changed", async (e) => {
  const skins = await invoke<SkinInfo[]>("list_skins").catch(() => []);
  renderSkins(skins, e.payload.name);
});
