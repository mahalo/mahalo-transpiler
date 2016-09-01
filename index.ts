import * as ts from 'typescript';
import {resolve, basename} from 'path';
import {existsSync, readFileSync} from 'fs';
import {SourceMapConsumer, SourceMapGenerator} from 'source-map';

type Change = {
    start: number,
    length: number,
    newText: string,
    depth?: number
};

export default function mahaloTranspiler(moduleName: string, shouldDiagnose = false) {
    let fileName = resolveModuleName(moduleName);
    let program = ts.createProgram([fileName], {moduleResolution: ts.ModuleResolutionKind.NodeJs});
    let checker = program.getTypeChecker();
    let sourceFile = program.getSourceFile(fileName);
    let text = sourceFile.text;
    let edits: Change[] = [];
    let identifiers = [];
    let assignIdentifier = 'assign';
    let promiseIdentifier = 'Promise';
    let shouldImportAssign = false;
    let shouldImportPromise = true;
    let assignmentDepth = 0;
    let mahaloMap;
    
    shouldDiagnose && [
        // 'getDeclarationDiagnostics',
        'getGlobalDiagnostics',
        'getOptionsDiagnostics',
        'getSemanticDiagnostics',
        'getSyntacticDiagnostics'
    ].forEach(method => program[method]().forEach(diagnostic => {
        if (diagnostic.category === ts.DiagnosticCategory.Error) {
            throw Error(diagnostic.messageText.toString());
        }
    }));

    if (!/\/(mahalo|core-js)\//.test(fileName)) {
        findIdentifiers(sourceFile);

        while (identifiers.indexOf(assignIdentifier) > -1) {
            assignIdentifier = '_' + assignIdentifier;
        }

        while (identifiers.indexOf(promiseIdentifier) > -1) {
            promiseIdentifier = '_' + promiseIdentifier;
        }

        findEdits(sourceFile);

        importModules();

        let edited = applyEdits(basename(fileName), text, edits);

        text = edited.text;

        mahaloMap = edited.map;
    }

    let result = ts.transpileModule(text, {
        fileName: fileName,
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            sourceMap: true
        }
    });

    return {
        fileName: fileName,
        text: result.outputText.replace(/(\r\n|\r|\n)\/\/# sourceMappingURL=.*\.js\.map$/, ''),
        map: mergeSourceMaps(mahaloMap, JSON.parse(result.sourceMapText))
    };


    //////////


    function findIdentifiers(node: ts.Node) {
        switch (node.kind) {
            case ts.SyntaxKind.FunctionDeclaration:
            case ts.SyntaxKind.FunctionExpression:
            case ts.SyntaxKind.SourceFile:
                Object.keys(node['locals']).forEach(identifier => identifiers.push(identifier));
        }
        
        ts.forEachChild(node, findIdentifiers);
    }

    function findEdits(node: ts.Node) {
        switch (node.kind) {
            case ts.SyntaxKind.BinaryExpression:
                switch ((<ts.BinaryExpression>node).operatorToken.kind) {
                    case ts.SyntaxKind.FirstAssignment:
                    case ts.SyntaxKind.PlusEqualsToken:
                    case ts.SyntaxKind.MinusEqualsToken:
                    case ts.SyntaxKind.AsteriskEqualsToken:
                    case ts.SyntaxKind.SlashEqualsToken:
                    case ts.SyntaxKind.PercentEqualsToken:
                    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
                    case ts.SyntaxKind.BarEqualsToken:
                    case ts.SyntaxKind.AmpersandEqualsToken:
                    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
                    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
                    case ts.SyntaxKind.LessThanLessThanEqualsToken:
                    case ts.SyntaxKind.CaretEqualsToken:

                        createAssignmentEdit(<ts.BinaryExpression>node);

                        assignmentDepth++;
                        ts.forEachChild(node, findEdits);
                        assignmentDepth--;

                        return;
                }

                break;

            case ts.SyntaxKind.PrefixUnaryExpression:
            case ts.SyntaxKind.PostfixUnaryExpression:

                createUpdateEdit(<ts.PrefixUnaryExpression | ts.PostfixUnaryExpression>node);

                break;

            case ts.SyntaxKind.DeleteExpression:

                createDeleteEdit(<ts.DeleteExpression>node);

                break;

            case ts.SyntaxKind.ClassDeclaration:

                createRouteEdit(<ts.ClassDeclaration>node);

                break;
        }

        ts.forEachChild(node, findEdits);
    }

    function createAssignmentEdit(node: ts.BinaryExpression) {
        let change = <Change>{
            start: node.getStart(),
            length: node.getWidth(),
            newText: '',
            depth: assignmentDepth
        };

        let operatorToken = node.operatorToken;

        let left = <ts.PropertyAccessExpression>node.left;

        if (left.kind === ts.SyntaxKind.PropertyAccessExpression) {
            let object = left.expression.getText();
            let key = left.name.getText();
            let value = node.right.getText();

            if (operatorToken.kind !== ts.SyntaxKind.FirstAssignment) {
                let operator = operatorToken.getText().substr(0, operatorToken.getWidth() - 1);

                value = `${left.getText()} ${operator} ${value}`;
            }

            change.newText = `${assignIdentifier}(${object}, ${JSON.stringify(key)}, ${value})`;
        } else {
            change.newText = `${assignIdentifier}(${node.getText()})`;
        }

        edits.push(change);

        shouldImportAssign = true;
    }

    function createUpdateEdit(node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression) {
        if ([ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].indexOf(node.operator) === -1) {
            return;
        }

        let operator = node.operator === ts.SyntaxKind.PlusPlusToken ? '+' : '-';
        let change = <Change>{
            start: node.getStart(),
            length: node.getWidth()
        };

        let operand = <ts.PropertyAccessExpression>node.operand;

        if (operand.kind === ts.SyntaxKind.PropertyAccessExpression) {
            let object = operand.expression.getText();
            let key = operand.name.getText();
            let value = `${operand.getText()} ${operator} 1`;

            change.newText = `${assignIdentifier}(${object}, ${JSON.stringify(key)}, ${value})`;

            if (node.kind === ts.SyntaxKind.PostfixUnaryExpression) {
                change.newText = `(${change.newText} ${operator === '+' ? '-' : '+'} 1)`;
            }
        } else {
            
            change.newText = `${assignIdentifier}(${node.getText()})`;
        }

        edits.push(change);

        shouldImportAssign = true;
    }

    function createDeleteEdit(node: ts.DeleteExpression) {
        let expression = <ts.PropertyAccessExpression>node.expression;

        if (node.expression.kind !== ts.SyntaxKind.PropertyAccessExpression) {
            return;
        }
        
        
        let object = expression.expression.getText();
        let key = expression.name.getText();
         
        edits.push({
            start: node.getStart(),
            length: node.getWidth(),
            newText: `${assignIdentifier}(${object}, ${JSON.stringify(key)})`
        });

        shouldImportAssign = true;
    }

    function createRouteEdit(node: ts.ClassDeclaration) {
        if (!extendsRoute(node)) {
            return;
        }

        for (let member of node.members) {
            if (member.name.getText() === 'view') {
                let initializer = <ts.StringLiteral>member['initializer'];

                if (initializer && initializer.kind === ts.SyntaxKind.StringLiteral) {
                    let view = initializer.text;
                    
                    edits.push({
                        start: initializer.getStart(),
                        length: initializer.getWidth(),
                        newText: `() => {
                            return new ${promiseIdentifier}(resolve => {
                                require.ensure(${JSON.stringify(view)}, require => {
                                    resolve(require(${JSON.stringify(view)}));
                                });
                            });
                        }`
                    });

                    shouldImportPromise = true;
                }
                
                return;
            }
        }
    }

    function extendsRoute(node: ts.ClassDeclaration): boolean {
        if (node.heritageClauses) {
            for (let clause of node.heritageClauses) {
                if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
                    let symbolForType = checker.getTypeAtLocation(clause.types[0].expression).symbol;
                    
                    if (symbolForType.name === 'default' && symbolForType['parent']) {
                        if (/\/node_modules\/mahalo\/components\/route"$/.test(symbolForType['parent'].name)) {
                            return true;
                        }

                        if (symbolForType.valueDeclaration.kind === ts.SyntaxKind.ClassDeclaration) {
                            return extendsRoute(<ts.ClassDeclaration>symbolForType.valueDeclaration);
                        }
                    }
                    
                    break;
                }
            }
        }

        return false;
    }

    function importModules() {
        shouldImportPromise && edits.unshift({
            start: 0,
            length: 0,
            newText: "import * as " + promiseIdentifier + " from 'core-js/library/es6/promise';\n"
        });

        shouldImportAssign && edits.unshift({
            start: 0,
            length: 0,
            newText: "import {assign as " + assignIdentifier + "} from 'mahalo';\n"
        });
    }
}


//////////


function resolveModuleName(moduleName: string) {
    let host = ts.createCompilerHost({allowJs: true});
    let file = ts.nodeModuleNameResolver(moduleName, '', {allowJs: true}, host);
    
    if (!file) {
        throw Error('Cannot find module ' + moduleName);
    }

    return resolve(file.resolvedModule.resolvedFileName).replace(/\\/g, '/');
}

function applyEdits(fileName: string, text: string, edits: Change[]) {
    let result = text;
    let mapGenerator = new SourceMapGenerator();
    let change = edits[0];
    let i = 0;
    let delta = 0;

    while (change) {
        let depth = change.depth || 0;
        let start = change.start + delta - depth;
        let head = result.substr(0, start);
        let tail = result.substr(start + change.length);

        delta += change.newText.length - change.length;
        result = head + change.newText + tail;

        mapGenerator.addMapping({
            generated: getLineAndColumn(result, start),
            original: getLineAndColumn(text, change.start),
            source: fileName
        });

        change = edits[++i];
    }

    return {
        text: result,
        map: JSON.parse(mapGenerator.toString())
    };
}

/**
 * Merges the source maps provided by each of the two steps.
 */
function mergeSourceMaps(mahaloMap: {sources: string[]}, typescriptMap: {}) {
    if (!mahaloMap) {
        return typescriptMap;
    }
    
    let mahaloMapConsumer = new SourceMapConsumer(mahaloMap);
    let typescriptMapConsumer = new SourceMapConsumer(typescriptMap);
    let mergedMapGenerator = new SourceMapGenerator();

    typescriptMapConsumer.eachMapping(function (mapping) {
        let originalPosition = mahaloMapConsumer.originalPositionFor({
            line: mapping.originalLine,
            column: mapping.originalColumn
        });

        if (!originalPosition.source) {
            return;
        }

        mergedMapGenerator.addMapping({
            original: {
                line: originalPosition.line,
                column: originalPosition.column
            },
            generated: {
                line: mapping.generatedLine,
                column: mapping.generatedColumn
            },
            source: mapping.source,
            name: mapping.name
        });
    });

    let mergedMap = JSON.parse(mergedMapGenerator.toString());

    mergedMap.sources = mahaloMap.sources;
    
    return mergedMap;
}

function getLineAndColumn(text, i) {
    var line = 1,
        column = 0;
    
    while (i--) {
        text[i] === '\n' && line++;
        line === 1 && column++;
    }

    return {line: line, column: column};
}