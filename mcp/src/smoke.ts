/**
 * Starts the built server (dist/index.js) the way an MCP client would and
 * calls every tool once. `npm run build && npm test`; set TOLARA_DATA_DIR
 * to test against a local export instead of the live site.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env } as Record<string, string> }));

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
const { prompts } = await client.listPrompts();
console.log("prompts:", prompts.map((p) => p.name).join(", "));

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text: string }>)[0].text;
  if (res.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};

const ov = await call("tolara_overview", {});
console.log(`overview: ${ov.open_pm_roles} roles at ${ov.companies} companies, ${ov.industries.length} industries`);

const s = await call("search_roles", { location: "New York", levels: ["senior"], min_salary: 200000, sort: "salary", limit: 3 });
console.log(`search NYC senior $200k+: ${s.total_matching} matches`);
for (const r of s.roles) console.log(`  ${r.id} ${r.title} @ ${r.company} | ${r.salary} | ${r.pay_rank} | ${r.tolara_url}`);

const role = await call("get_role", { role_id: s.roles[0].id });
console.log(`get_role: ${role.title}, open_for=${role.open_for}, focus=${role.what_the_role_focuses_on?.length ?? 0} bullets, others=${role.other_open_pm_roles_at_company}`);

const co = await call("get_company", { company: "capital one" });
console.log(`get_company: ${co.name} ${co.open_pm_roles} roles, trend weeks=${co.hiring_trend_by_week.length}, leaders=${co.leaders.length}, news=${co.recent_news.length}`);

const nw = await call("whats_new", { days: 3, remote: "remote" });
console.log(`whats_new 3d remote: ${nw.new_roles_count} new, ${nw.closed_roles_count} closed (closed list is not remote-filtered)`);

const miss = await call("get_company", { company: "Definitely Not A Company" });
console.log(`unknown company: ${miss.message}`);

await client.close();
