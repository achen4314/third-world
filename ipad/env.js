/* 第三世界 · 公开配置（可提交）
 *
 * 这里的 key 是 Supabase 的 **publishable key**（旧称 anon key），设计上就是给浏览器用的：
 * 它只能拿到「RLS 允许匿名身份看的东西」，真正的闸门是数据库行级权限，不是这把 key。
 * 绝对不要把这个文件写成 service_role / secret key —— 那个只能待在服务端。
 *
 * 取值路径（任一）：
 *   1. Dashboard → Project Settings → API Keys → Publishable key → Copy
 *   2. Dashboard → Connect（顶部按钮）→ App Frameworks → 复制整段配置
 *   3. 不填也行：在页面控制台「数据源」里粘贴一次，会存到本机 localStorage，刷新不丢。
 */
window.ARC_ENV = {
  SUPABASE_URL: "https://bffuuxdnztowlwbxjlzp.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_ccxC5xPgM_Gq6kqAIUb6-A_4-OokJoa",
  // 允许在运行时粘贴 key（本机调试用）。上线打包时置 false，只认上面那一行。
  ALLOW_RUNTIME_KEY: false
};
