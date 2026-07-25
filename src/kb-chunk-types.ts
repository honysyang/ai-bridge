/**
 * 知识库 Chunk 类型定义（v5.6.0）
 *
 * Chunk 是知识库检索的最小单位。一个 KBItem 可包含多个 Chunk，
 * 每个 Chunk 独立生成 embedding，用于向量检索。
 */

export interface KBChunk {
  id: string; // kb-chunk-<ts>-<n>
  item_id: string; // 所属 KBItem.id
  chunk_index: number; // 在条目内的顺序
  content: string; // 检索文本片段
  source_path?: string; // 来源路径（如仓库文件路径）
  token_count?: number; // 估算 token 数
  embedding?: number[]; // 向量（JSONL 中可选存储，内存中必须有）
  embedding_model?: string; // 生成向量的模型标识 provider/model
  created_at: number;
}
