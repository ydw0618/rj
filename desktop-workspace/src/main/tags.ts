const stop = new Set('软件 项目 文档 文件 内容 说明 一个 一个是 这个 可以 目前 使用 进行 支持 需要 首先 第一 主要 通过 以及 相关 没有 后续 现在 完成 用来 版本 目录 什么 如何 其中 这份 标题 默认 而且 用户 工作 实现 能够 the and for with from this that'.split(' '));

export function inferTags(title: string, markdown: string): string[] {
  const segments = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  const scores = new Map<string, number>();
  const collect = (value: string, weight: number) => {
    const unique = new Set<string>();
    for (const item of segments.segment(value)) {
      const word = item.segment.toLowerCase();
      if (!item.isWordLike || word.length < 2 || word.length > 18 || stop.has(word) || /^\d+$/.test(word) || unique.has(word)) continue;
      unique.add(word);
      scores.set(word, (scores.get(word) ?? 0) + weight);
    }
  };

  collect(title, 5);
  const headings = markdown.match(/^#{1,6}\s+.+$/gm) ?? [];
  for (const heading of headings.slice(0, 40)) collect(heading, 3);
  for (const paragraph of markdown.slice(0, 12_000).split(/\r?\n/).slice(0, 100)) collect(paragraph, 1);
  return [...scores].filter(([, score]) => score >= 2).sort((left, right) => right[1] - left[1]).slice(0, 4).map(([word]) => word);
}
