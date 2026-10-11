/** This guard complements mandatory OS isolation; project plugins are untrusted code. */
export const NATIVE_EXECUTION_GUARD = `export default {
 id: "subpolar.execution.guard",
 async setup(ctx) {
  await ctx.tool.transform(editor => {
   for (const tool of editor.list()) {
    if (!tool.id.startsWith("subpolar_")) editor.remove(tool.id)
   }
  });
  await ctx.shell.hook("create.before", () => { throw new Error("Native shell execution disabled by Subpolar"); });
 }
};
`
export interface AcpMcpServer {type:'http';name:string;url:string;headers:Array<{name:string;value:string}>}
export function mcpDescriptor(url: string, token: string): AcpMcpServer {
  const parsed = new URL(url)
  if (!['http:','https:'].includes(parsed.protocol) || !token || parsed.username || parsed.password) throw new Error('Invalid scoped MCP bridge')
  return {type:'http',name:'subpolar',url:parsed.href,headers:[{name:'Authorization',value:`Bearer ${token}`}]}
}
export function controlledConfiguration(guardPath: string): Record<string,unknown> {
 return {update:'disable',snapshots:false,formatter:false,plugins:[guardPath],permissions:[{action:'*',resource:'*',effect:'deny'},{action:'subpolar_*',resource:'*',effect:'allow'}],mcp:{servers:{}}}
}
