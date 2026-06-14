import { Project } from 'ts-morph';
import ts from 'typescript';

const project = new Project({
  tsConfigFilePath: false,
  compilerOptions: { target: ts.ScriptTarget.Latest },
});

const sf = project.createSourceFile('test.ts', `
// Case 1: default export of a reference
const InputFactory = () => {};
InputFactory.displayName = 'InputFactory';
export default InputFactory;

// Case 2: default export of inline function
export default function Foo() {}

// Case 3: default export of inline arrow
export default () => {}

// Case 4: default export of inline object
export default { a: 1 }

// Case 5: named export
export { InputFactory }

// Case 6: export const
export const MyVar = 123;

// Case 7: export function
export function MyFn() {}

// Case 8: export class
export class MyClass {}
`);

function syntaxKindName(kind: ts.SyntaxKind): string {
  const name = ts.SyntaxKind[kind];
  return name;
}

console.log('=== EXPORT ANALYSIS ===\n');

sf.forEachChild(node => {
  const kind = node.getKind();
  const kindName = syntaxKindName(kind);
  
  // Skip comments
  if (node.getText().trim().startsWith('//')) return;
  
  // Check for export-related nodes
  if (kindName.includes('Export') || kindName.includes('Variable') || 
      kindName.includes('Function') || kindName.includes('Class')) {
    
    console.log(`Kind: ${kindName}`);
    
    // Try to get a name
    try {
      const name = (node as any).getName?.();
      if (name) console.log(`  Name: ${name}`);
    } catch (e) {}
    
    // Check if it's exported
    try {
      const isExported = (node as any).isExported?.();
      console.log(`  isExported(): ${isExported}`);
    } catch (e) {}
    
    // Get the text
    let text = node.getText();
    if (text.length > 80) text = text.substring(0, 77) + '...';
    console.log(`  Text: "${text}"`);
    
    // Children info
    const children = node.getChildren();
    console.log(`  Children count: ${children.length}`);
    for (let i = 0; i < Math.min(3, children.length); i++) {
      const child = children[i];
      const childKind = syntaxKindName(child.getKind());
      let childText = child.getText();
      if (childText.length > 40) childText = childText.substring(0, 37) + '...';
      console.log(`    [${i}] ${childKind}: "${childText}"`);
    }
    
    console.log();
  }
});

sf.delete();
