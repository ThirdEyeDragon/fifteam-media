// node test/groups.test.mjs - group chats' rules on the server (tools/bot/hub.mjs guardGroups): what each phone may
// change in a group, checked against its account. (hub.mjs runs on Cloudflare: its import of the runtime is left out
// here, and the rules, which don't use it, are tested on their own.)
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, "..", "tools", "bot", "hub.mjs"), "utf8").replace(/^import .*cloudflare:workers.*$/m, "class DurableObject {}");
const { guardGroups, cleanGroup } = await import("data:text/javascript," + encodeURIComponent(src));
let fails = 0;
const check = (ok, what) => { console.log(`  ${ok ? "ok" : "FAIL"}: ${what}`); if (!ok) fails++; };
const clone = (x) => structuredClone(x);

const own = "ownerphone1", adm = "adminphone1", mem = "memberphone", mem2 = "member2phon", out = "outsiderphn";
const k = (b) => ({ b, iv: "aaaaaaaaaaaaaaaa", c: "c" + b });
const G = { id: "gtestgroup01", name: "Bass heads", by: own, at: 1, members: [own, adm, mem, mem2], admins: [own, adm], kv: 1, keys: { 1: { [own]: k(own), [adm]: k(own), [mem]: k(own), [mem2]: k(own) } } };
const M1 = { id: "msgfromowner1", f: own, g: G.id, kv: 1, at: 10, iv: "x", c: "y" };
const M2 = { id: "msgfrommember", f: mem, g: G.id, kv: 1, at: 20, iv: "x", c: "y" };
const DM = { id: "plaindmmsg01", f: own, t: mem, at: 5, iv: "x", c: "y" };
const base = () => ({ v: 1, msgs: [DM, M1, M2], del: [], groups: [G] });
/** A write: the store before, what the phone sends, who sent it; the store as it's kept. */
const write = (prev, d, who) => { d = clone(d); guardGroups(clone(prev), d, who); return d; };
const grp = (d) => d.groups.find((g) => g.id === G.id);

// making a group
{
  const fresh = { ...clone(G), id: "gnewgroup0001", by: mem, members: [mem, mem2], admins: [mem], keys: { 1: { [mem]: k(mem), [mem2]: k(mem) } } };
  const a = write(base(), { ...base(), groups: [G, fresh] }, mem);
  const b = write(base(), { ...base(), groups: [G, { ...fresh, by: own }] }, mem);
  const c = write(base(), { ...base(), groups: [G, fresh] }, "");
  check(a.groups.length === 2 && b.groups.length === 1 && c.groups.length === 1, "a new group: kept when it's the writer's own (with itself an admin); not in someone else's name, or with no account");
}
// renaming, adding people
{
  const renamed = (who) => grp(write(base(), { ...base(), groups: [{ ...clone(G), name: "Renamed" }] }, who)).name;
  check(renamed(adm) === "Renamed" && renamed(own) === "Renamed" && renamed(mem) === "Bass heads" && renamed(out) === "Bass heads", "rename: an admin or the owner can; a member or an outsider can't");
  const added = (who) => { const g = clone(G); g.members.push(out); g.keys[1][out] = k(who); return grp(write(base(), { ...base(), groups: [g] }, who)).members.includes(out); };
  check(added(adm) && !added(mem), "add someone: an admin can, a member can't");
}
// removing people (a new key, for the members left)
{
  const removed = (who, whom, rekey = true) => {
    const g = clone(G); g.members = g.members.filter((x) => x !== whom); g.admins = g.admins.filter((x) => x !== whom);
    if (rekey) { g.kv = 2; g.keys[2] = Object.fromEntries(g.members.map((x) => [x, k(who)])); }
    return !grp(write(base(), { ...base(), groups: [g] }, who)).members.includes(whom);
  };
  check(removed(adm, mem) && removed(own, mem), "remove a member: an admin or the owner can");
  check(!removed(mem, mem2), "remove someone: a member can't");
  check(!removed(adm, own), "the owner can't be removed by an admin");
  // (two admins besides the owner: one can't remove the other)
  const two = { ...base(), groups: [{ ...clone(G), admins: [own, adm, mem] }] };
  const g2 = clone(two.groups[0]); g2.members = g2.members.filter((x) => x !== mem); g2.admins = g2.admins.filter((x) => x !== mem); g2.kv = 2; g2.keys[2] = Object.fromEntries(g2.members.map((x) => [x, k(adm)]));
  check(removed(own, adm) && grp(write(two, { ...two, groups: [g2] }, adm)).members.includes(mem), "remove an admin: the owner can, another admin can't");
  check(!removed(adm, mem, false), "someone removed without a new key: not taken (they'd still read new messages)");
  const g = clone(G); g.members = g.members.filter((x) => x !== mem); g.kv = 2; g.keys[2] = Object.fromEntries([...g.members, mem].map((x) => [x, k(adm)]));
  check(grp(write(base(), { ...base(), groups: [g] }, adm)).members.includes(mem), "a new key handed to the one removed: not taken");
}
// admins
{
  const made = (who) => { const g = clone(G); g.admins.push(mem); return grp(write(base(), { ...base(), groups: [g] }, who)).admins.includes(mem); };
  const unmade = (who) => { const g = clone(G); g.admins = g.admins.filter((x) => x !== adm); return !grp(write(base(), { ...base(), groups: [g] }, who)).admins.includes(adm); };
  check(made(adm) && made(own) && !made(mem), "make an admin: an admin or the owner can, a member can't");
  check(unmade(own) && !unmade(adm) && !unmade(mem), "unmake an admin: only the owner");
}
// leaving
{
  const left = (who) => { const g = clone(G); g.members = g.members.filter((x) => x !== who); g.admins = g.admins.filter((x) => x !== who); return !grp(write(base(), { ...base(), groups: [g] }, who)).members.includes(who); };
  check(left(mem) && left(adm), "leave: a member or an admin can leave");
  const g = clone(G); g.members = g.members.filter((x) => x !== mem2 && x !== mem);
  check(grp(write(base(), { ...base(), groups: [g] }, mem)).members.includes(mem2), "leave: only itself (a member can't take someone else out with it)");
  const o = clone(G); o.members = o.members.filter((x) => x !== own); o.admins = [adm]; o.by = adm;
  const kept = grp(write(base(), { ...base(), groups: [o] }, own));
  check(kept.by === adm && !kept.members.includes(own), "the owner leaving hands the group to an admin");
}
// deleting the group
{
  const del = (who) => { const d = base(); d.groups = []; d.msgs = [DM]; d.del = [M1.id, M2.id]; return write(base(), d, who); };
  const byOwner = del(own), byAdmin = del(adm), byMember = del(mem);
  check(!byOwner.groups.length && !byOwner.msgs.some((m) => m.g), "delete the group: the owner can (its messages go with it)");
  check(byAdmin.groups.length === 1 && byMember.groups.length === 1, "delete the group: an admin or a member can't (it's put back)");
  check(byMember.msgs.some((m) => m.id === M1.id) && !byMember.msgs.some((m) => m.id === M2.id), "...and a member trying it deletes only their own messages (the others are put back)");
}
// messages
{
  const send = (who, f = who) => write(base(), { ...base(), msgs: [DM, M1, M2, { id: "newmsg000001", f, g: G.id, kv: 1, at: 30, iv: "x", c: "y" }] }, who).msgs.some((m) => m.id === "newmsg000001");
  check(send(mem) && !send(out) && !send(mem, mem2) && !send(""), "a message: from a member as itself; not from an outsider, not as someone else, not with no account");
  const delMsg = (who, m) => { const d = base(); d.msgs = d.msgs.filter((x) => x.id !== m.id); d.del = [m.id]; return !write(base(), d, who).msgs.some((x) => x.id === m.id); };
  check(delMsg(mem, M2) && delMsg(adm, M2) && delMsg(own, M2), "delete a message: whoever sent it, or an admin");
  check(!delMsg(mem2, M2) && !delMsg(mem, M1), "delete someone else's message: a member can't");
}
// an app from before groups (it leaves them, and their messages, out)
{
  const old = write(base(), { v: 1, msgs: [DM], del: [] }, "");
  check(old.groups.length === 1 && old.msgs.filter((m) => m.g).length === 2 && old.msgs.some((m) => m.id === DM.id), "an older app's write: the groups and their messages are put back");
  const same = base(), d = write(same, base(), mem);
  check(JSON.stringify(d.msgs) === JSON.stringify(same.msgs), "nothing changed: nothing changed");
}
check(cleanGroup({ id: "bad", by: own }) === null && cleanGroup(G).members.length === 4, "a group's shape is checked");
console.log(fails ? `FAIL (${fails})` : "groups: all ok");
process.exit(fails ? 1 : 0);
