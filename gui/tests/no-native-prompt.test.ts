import { expect, test } from "bun:test";
import ts from "typescript";

test("runtime GUI sources never use browser-native prompt dialogs", async () => {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const promptCalls: string[] = [];

  for await (const path of glob.scan({ cwd: new URL("../src/", import.meta.url).pathname })) {
    const source = await Bun.file(new URL(`../src/${path}`, import.meta.url)).text();
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if ((ts.isIdentifier(expression) && expression.text === "prompt")
          || (ts.isPropertyAccessExpression(expression)
            && expression.name.text === "prompt"
            && ts.isIdentifier(expression.expression)
            && expression.expression.text === "window")) {
          promptCalls.push(path);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  expect(promptCalls.sort()).toEqual([]);
});
