// Embed the bridge so Paseo's TypeScript bundle needs no separate Python asset.
// No model code is vendored. The user installs Laya in their Python environment.
export const LAYA_WORKER = String.raw`
import contextlib
import json
import sys

MAX_LINE_BYTES = 65536

def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)

def check_budget(agent, state, questions):
    # Match Laya 0.3.5 serialization. Reject instead of silently truncating any
    # part of the supplied state or the fixed authorization rubric.
    from laya.common import render_options, serialize_state
    tok = agent.tok
    maximum = agent.cfg.get("max_len", 512)
    head = agent.cfg.get("head_max_len", 192)
    if not isinstance(maximum, int) or not 128 <= maximum <= 1024:
        raise ValueError("budget")
    if not isinstance(head, int) or not 32 <= head < maximum:
        raise ValueError("budget")
    def tokens(text):
        return len(tok(text.replace(tok.mask_token, " "), add_special_tokens=False)["input_ids"])
    state_tokens = tokens(serialize_state(state))
    for question in questions.values():
        q = agent._to_internal(question)
        options = [tokens(" " + option) for option in render_options(q)]
        instruction = tokens(q["t"] + " question: " + q["ins"])
        if any(size > 48 for size in options):
            raise ValueError("budget")
        option_size = sum(size + 1 for size in options)
        if instruction > max(8, head - option_size) or head - option_size < 16:
            raise ValueError("budget")
        if state_tokens + instruction + option_size + 4 > maximum:
            raise ValueError("budget")

def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import laya
            if laya.__version__ != "0.3.5":
                raise RuntimeError("version")
            config = json.loads(sys.argv[1])
            subfolder = {"english": None, "multilingual": "multilingual", "typed-decisions": "typed-decisions"}[config["model"]]
            agent = laya.load("convaiinnovations/laya", subfolder=subfolder,
                              device=None if config["device"] == "auto" else config["device"])
            if config["device"] != "auto" and agent.device.type != config["device"]:
                raise RuntimeError("device")
    except Exception:
        emit({"error": "startup"})
        return
    emit({"ready": True})
    while True:
        raw = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
        if not raw:
            return
        if len(raw) > MAX_LINE_BYTES or not raw.endswith(b"\n"):
            emit({"error": "protocol"})
            return
        try:
            request = json.loads(raw)
            if not isinstance(request, dict) or not isinstance(request.get("state"), dict) or not isinstance(request.get("questions"), dict):
                raise ValueError("protocol")
            check_budget(agent, request["state"], request["questions"])
        except Exception:
            emit({"error": "context"})
            continue
        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = agent.predict(request["state"], request["questions"])
            if config["device"] != "auto" and agent.device.type != config["device"]:
                emit({"error": "device"})
                continue
            emit({"answers": result["answers"]})
        except Exception:
            emit({"error": "inference"})

if __name__ == "__main__":
    main()
`;
