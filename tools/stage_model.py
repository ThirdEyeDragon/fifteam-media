"""Cut the bass separator's graph into K stages run one after another (ONNX Runtime frees a run's in-between buffers
only when the run ends: one run per 7.8 s piece held ~2 GB on the graphics chip; K short runs hold one stage's worth).
Every stage keeps the weights as external data in "bass-sep.weights" at the same offsets, so the app's packed weights
(bass-sep.q8) are unchanged.
  python tools/stage_model.py <bass-sep.onnx> 16 bass-sep.stages   (then gzip -9 it into models/bass-sep.stages.gz)
The container: "FTST", u32 header length, a JSON header { stages: [{ len, inputs, outputs }], outputs, last: { tensor:
stage index of its last use } }, then the stages' ONNX bytes one after another."""
import sys, json, struct
import numpy as np
import onnx
from onnx import shape_inference, helper

src, K, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
m = onnx.load(src, load_external_data=False)
mi = shape_inference.infer_shapes(m)
g = m.graph
vinfo = {vi.name: vi for vi in list(mi.graph.value_info) + list(mi.graph.input) + list(mi.graph.output)}

def nbytes(name):
    vi = vinfo.get(name)
    if vi is None:
        return 0
    t = vi.type.tensor_type
    dims = [d.dim_value for d in t.shape.dim]
    el = {1: 4, 10: 2, 7: 8, 6: 4, 9: 1}.get(t.elem_type, 4)
    return int(np.prod(dims)) * el if dims and all(d > 0 for d in dims) else 0

inits = {t.name: t for t in g.initializer}
nodes = list(g.node)
N = len(nodes)
prod, last = {}, {}
for x in g.input:
    prod[x.name] = -1
for i, nd in enumerate(nodes):
    for o in nd.output:
        prod[o] = i
    for x in nd.input:
        if x and x not in inits:
            last[x] = i
gout = [o.name for o in g.output]
for o in gout:
    last[o] = N
# the bytes carried across a cut before node i
ev = np.zeros(N + 2)
for t, li in last.items():
    p = prod.get(t)
    if p is None:
        continue
    ev[p + 1] += nbytes(t)
    ev[min(li, N) + 1] -= nbytes(t)
cross = np.cumsum(ev)[:N]
cuts = []
for k in range(1, K):
    c = int(N * k / K)
    w = max(8, N // (K * 4))
    lo, hi = max(1, c - w), min(N - 1, c + w)
    cuts.append(lo + int(np.argmin(cross[lo:hi])))
bounds = [0] + cuts + [N]
print("carried at each cut (MB):", [round(cross[j] / 1e6, 1) for j in cuts])

stage_of = {}
for s in range(K):
    for i in range(bounds[s], bounds[s + 1]):
        for o in nodes[i].output:
            stage_of[o] = s
blobs, hdr_stages, last_use = [], [], {}
for s in range(K):
    ns = nodes[bounds[s]:bounds[s + 1]]
    made = {o for nd in ns for o in nd.output}
    used = []
    for nd in ns:
        for x in nd.input:
            if x and x not in inits and x not in made and x not in used:
                used.append(x)
    # outputs: what later stages (or the graph's outputs) need from this one
    outs = []
    for nd in ns:
        for o in nd.output:
            if o in last and (last[o] >= bounds[s + 1] or o in gout) and o not in outs:
                outs.append(o)
    for x in used:
        last_use[x] = s
    need = {x for nd in ns for x in nd.input if x in inits}
    ginits = [inits[n] for n in inits if n in need]
    vis = lambda names: [vinfo[n] for n in names]
    sg = helper.make_graph(ns, f"stage{s}", vis(used), vis(outs), initializer=ginits)
    sm = helper.make_model(sg, opset_imports=m.opset_import, producer_name="fifteam-stage")
    sm.ir_version = m.ir_version
    b = sm.SerializeToString()
    blobs.append(b)
    hdr_stages.append({"len": len(b), "inputs": used, "outputs": outs})
    print(f"stage {s}: {len(ns)} nodes, {len(used)} in, {len(outs)} out, carried in {sum(nbytes(x) for x in used) / 1e6:.0f} MB, {len(b)} bytes")
hdr = json.dumps({"stages": hdr_stages, "outputs": gout, "last": last_use}).encode()
with open(out, "wb") as f:
    f.write(b"FTST" + struct.pack("<I", len(hdr)) + hdr)
    for b in blobs:
        f.write(b)
print("written", out)
