// 设置 › 插件 › MCP 服务: the services the person adds (settings/McpServers.tsx, shared/mcp-servers.ts, main/mcp/store.ts).
import type { Catalog } from '../index';

export const EN_MCP: Catalog = {
  'MCP 服务': 'MCP servers',
  '添加 MCP 服务': 'Add MCP server',
  '未添加 MCP 服务': 'No MCP servers added',
  '编辑「{name}」': 'Edit “{name}”',
  '命令|field': 'Command',
  参数: 'Arguments',
  环境变量: 'Environment variables',
  变量名: 'Variable name',
  工具执行: 'Tool runs',
  直接执行: 'Run directly',
  '添加「{name}」？': 'Add “{name}”?',
  '保存「{name}」？': 'Save “{name}”?',
  '下载「{name}」？': 'Download “{name}”?',
  '另有 {n} 项未填入：{names}': '{n} more not filled in: {names}',
  '未识别到 MCP 服务配置': 'No MCP server configuration found',
  '只能用字母、数字、_ 和 -': 'Letters, digits, _ and - only',
  名称已被使用: 'Name already in use',
  '环境变量「{name}」重复': 'Environment variable “{name}” appears twice',
  '环境变量「{name}」没有值': 'Environment variable “{name}” has no value',
  该服务已不存在: 'This server no longer exists',
  '此电脑无法加密保存，环境变量未保存': 'This computer cannot store encrypted values; environment variables were not saved',
  待下载: 'Download needed',
  正在下载: 'Downloading',
  选择工作文件夹: 'Choose working folder',
};
