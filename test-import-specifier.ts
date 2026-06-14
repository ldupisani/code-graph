import { Project } from 'ts-morph';
import ts from 'typescript';

const project = new Project({
  tsConfigFilePath: './tsconfig.server.json',
});

const sf = project.createSourceFile('test-import-spec.ts', `
const InputFactory = () => {};
export default InputFactory;
`, { overwrite: true });

function syntaxKindName(kind: ts.SyntaxKind): string {
  return ts.SyntaxKind[kind];
}

let found = false;
sf.forEachChild(node => {
  const kind = node.getKind();
  const kindName = syntaxKindName(kind);
  
  if (kindName === 'ImportSpecifier' || node.getText().includes('export default')) {
    found = true;
    console.log(`\nKind: ${kindName}`);
    console.log(`Text: "${node.getText()}"`);
    
    // Get all children
    const children = node.getChildren();
    console.log(`\nChildren (${children.length}):`);
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const childKind = syntaxKindName(child.getKind());
      const childText = child.getText();
      console.log(`  [${i}] ${childKind}: "${childText}"`);
      
      // If it's an Identifier, check its details
      if (childKind === 'Identifier') {
        console.log(`      text().getText(): "${child.getText()}"`);
        try {
          const symbol = child.getSymbol();
          if (symbol) {
            console.log(`      Symbol name: ${symbol.getName()}`);
            const decls = symbol.getDeclarations();
            console.log(`      Symbol declarations: ${decls.length}`);
            for (const decl of decls) {
              const declKind = syntaxKindName(decl.getKind());
              console.log(`        - ${declKind}: "${decl.getText().substring(0, 40)}"`);
            }
          }
        } catch (e) {}
      }
    }
  }
});

if (!found) {
  console.log('No ImportSpecifier or export default found');
}

sf.delete();
