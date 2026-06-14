import { Project } from 'ts-morph';
import { extractAst } from './server/ast-extractor';

const project = new Project({ tsConfigFilePath: './tsconfig.server.json' });
const sf = project.createSourceFile('test-style.tsx', `
export const Foo = ({ tabIndex, separator }: any) => {
  return (
    <div
      style={{ color: 'red', padding: 4 }}
      className={cx('a', { active: true })}
      tabIndex={tabIndex}
    />
  );
};
`, { overwrite: true });

const { response } = extractAst(sf, 'file1', {});
const nodes = response.nodes as any[];
const byId = new Map(nodes.map(n => [n.id, n]));
for (const n of nodes) {
  const parent = n.parentId ? byId.get(n.parentId) : null;
  const extras = [n.op ? `op=${JSON.stringify(n.op)}` : '', n.collapsed ? 'collapsed' : ''].filter(Boolean).join(' ');
  console.log(`${n.syntaxKind.padEnd(26)} name=${String(JSON.stringify(n.name)).padEnd(14)} parent=${(parent ? parent.syntaxKind : 'ROOT').padEnd(22)} ${extras}`);
}
