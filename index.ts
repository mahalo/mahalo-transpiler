import * as ts from 'typescript';
import {resolve, basename, dirname, join} from 'path';
import {existsSync, readFileSync} from 'fs';
import {SourceMapConsumer, SourceMapGenerator, SourceNode} from 'source-map';
import * as mergeSourceMaps from 'merge-source-map';

const matchInject = /\/\*\s*inject\s*\*\//;
const matchAttributeAccessor = /:\s*\/\*\s*(get|eval|watch|bind)(\s*[a-z][a-z0-9-]*)?\s*\*\//;
const matchLocal = /\/\*\s*local\s*\*\//;

const attributeAccessors = {
    get: '',
    eval: '?',
    watch: '.',
    bind: ':'
};

const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES5,
    module: ts.ModuleKind.CommonJS,
    allowJs: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    noEmit: true,
    sourceMap: true
};

export default function mahaloTranspiler(moduleName: string, shouldDiagnose = false) {
    let fileName = resolveModuleName(moduleName);
    
    let program = getProgram(fileName);
    let checker = program.getTypeChecker();
    
    let sourceFile = program.getSourceFile(fileName);
    let sourceText = sourceFile.text;
    let sourceMap;

    let identifiers = [];
    
    let assignIdentifier = 'assign';
    let shouldImportAssign = false;

    shouldDiagnose && ts.getPreEmitDiagnostics(program, sourceFile).forEach(
        diagnostic => {
            if (diagnostic.category === ts.DiagnosticCategory.Error) {
                throw Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
            }
        }
    );
    
    if (!/\/node_modules\/(mahalo|core-js)\//.test(fileName)) {
        findIdentifiers(sourceFile);
        
        while (identifiers.indexOf(assignIdentifier) > -1) {
            assignIdentifier = '_' + assignIdentifier;
        }

        let sourceNode = createSourceNode(sourceFile);

        shouldImportAssign && sourceNode.prepend('import {assign as ' + assignIdentifier + "} from 'mahalo';\n");

        let stringWithSourceMap = sourceNode.toStringWithSourceMap();

        sourceText = stringWithSourceMap.code;
        
        sourceMap = JSON.parse(stringWithSourceMap.map.toString());
    }

    let result = ts.transpileModule(sourceText, {
        fileName: fileName,
        compilerOptions: compilerOptions
    });

    return {
        fileName: fileName,
        text: result.outputText.replace(/\s\/\/# sourceMappingURL=.*$/, ''),
        map: mergeSourceMaps(sourceMap, JSON.parse(result.sourceMapText))
    };


    //////////


    function findIdentifiers(node: ts.SourceFile|ts.FunctionDeclaration|ts.FunctionExpression|ts.NamespaceDeclaration|ts.ModuleDeclaration) {
        switch (node.kind) {
            case ts.SyntaxKind.SourceFile:
            case ts.SyntaxKind.ModuleDeclaration:
            case ts.SyntaxKind.FunctionDeclaration:
            case ts.SyntaxKind.FunctionExpression:
                Object.keys(node['locals']).forEach(identifier => identifiers.push(identifier));
        }
        
        ts.forEachChild(node, findIdentifiers);
    }

    function findEdits(node: EditKind, parentSourceNode: SourceNode) {
        let sourceNode = createSourceNode(node);

        parentSourceNode.add(sourceNode);

        switch (node.kind) {
            case ts.SyntaxKind.BinaryExpression:
                switch (node.operatorToken.kind) {
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
                        
                        return createAssignment(<ts.BinaryExpression>node, sourceNode);
                }

                break;

            case ts.SyntaxKind.PrefixUnaryExpression:
            case ts.SyntaxKind.PostfixUnaryExpression:

                switch (node.operator) {
                    case ts.SyntaxKind.PlusPlusToken:
                    case ts.SyntaxKind.MinusMinusToken:
                        
                        return createUpdateAssignment(<ts.PrefixUnaryExpression|ts.PostfixUnaryExpression>node, sourceNode);
                }
                
                break;

            case ts.SyntaxKind.DeleteExpression:

                switch (node.expression.kind) {
                    case ts.SyntaxKind.PropertyAccessExpression:
                    case ts.SyntaxKind.ElementAccessExpression:
                        
                        return createDeleteAssignment(<MemberKind>node.expression, sourceNode);
                }

                break;

            case ts.SyntaxKind.ClassDeclaration:
                if (
                    extendsClass(node, 'default', 'core/component') ||
                    extendsClass(node, 'default', 'core/behavior')
                ) {
                    createInject(node, sourceNode);
                }

                if (extendsClass(node, 'default', 'core/component')) {
                    createLocals(node, sourceNode);
                    createAttributes(node, sourceNode);
                }

                break;

            case ts.SyntaxKind.StringLiteral:
                let property = <ts.PropertyDeclaration>node.parent;
                let initializer = property.initializer;
                let name = property.name;
                let parent = <ts.ClassDeclaration>property.parent;
                
                if (
                    initializer === node &&
                    name.getText() === 'view' &&
                    parent.kind === ts.SyntaxKind.ClassDeclaration &&
                    extendsClass(parent, 'default', 'components/route')
                ) {
                    return createView(node, sourceNode);
                }
        }
    }

    function createSourceNode(node: ts.Node) {
        let start = node.getFullStart();
        let end = start + node.getFullWidth();
        let position = ts.getLineAndCharacterOfPosition(sourceFile, start);
        let sourceNode = new SourceNode(position.line + 1, position.character, fileName);

        ts.forEachChild(node, child => {
            let childStart = child.getFullStart();

            sourceNode.add(
                sourceText.substr(start, childStart - start)
            );

            start = childStart + child.getFullWidth();

            findEdits(<EditKind>child, sourceNode);
        });

        sourceNode.add(
            sourceText.substr(start, end - start)
        );

        return sourceNode;
    }

    function createAssignment(node: ts.BinaryExpression, sourceNode: SourceNode) {
        shouldImportAssign = true;

        let left = <MemberKind>node.left;

        if (!isMemberKind(left)) {
            sourceNode.prepend(assignIdentifier + '(');
            sourceNode.add(')');
            return;
        }

        let value = createSourceNode(node.right);
        let start = node.getFullStart();

        sourceNode.children.length = 0;
        sourceNode.add(sourceText.substr(start, node.getStart() - start));

        if (left.kind === ts.SyntaxKind.PropertyAccessExpression) {

            sourceNode.add(
                assignIdentifier + '(' +
                left.expression.getText() + ', ' +
                JSON.stringify(left.name.getText()) + ', '
            );

        } else if (left.kind === ts.SyntaxKind.ElementAccessExpression) {

            sourceNode.add(
                assignIdentifier + '(' +
                left.expression.getText() + ', ' +
                left.argumentExpression.getText() + ', '
            );
        }

        if (node.operatorToken.kind !== ts.SyntaxKind.FirstAssignment) {
            sourceNode.add([
                left.getText(),
                node.operatorToken.getText()[0]
            ]);
        }

        sourceNode.add([value, ')']);
    }

    function createUpdateAssignment(node: ts.PrefixUnaryExpression|ts.PostfixUnaryExpression, sourceNode: SourceNode) {
        shouldImportAssign = true;

        let operand = <MemberKind>node.operand;

        if (!isMemberKind(operand)) {
            sourceNode.prepend(assignIdentifier + '(');
            sourceNode.add(')');
            return;
        }

        let operator = node.operator === ts.SyntaxKind.PlusPlusToken ? '+' : '-';
        let value = operand.getText() + ' ' + operator + ' 1';
        let start = node.getFullStart();

        sourceNode.children.length = 0;
        sourceNode.add(sourceText.substr(start, node.getStart() - start));

        if (operand.kind === ts.SyntaxKind.PropertyAccessExpression) {

            sourceNode.add(
                assignIdentifier + '(' +
                operand.expression.getText() + ', ' +
                JSON.stringify(operand.name.getText()) + ', '
            );
            
        } else if (operand.kind === ts.SyntaxKind.ElementAccessExpression) {

            sourceNode.add(
                assignIdentifier + '(' +
                operand.expression.getText() + ', ' +
                operand.argumentExpression.getText() + ', '
            );
        }

        sourceNode.add(value + ')');

        if (node.kind === ts.SyntaxKind.PostfixUnaryExpression) {
            sourceNode.prepend('(');
            sourceNode.add(operator === '+' ? ' - 1)' : ' + 1)');
        }
    }

    function createDeleteAssignment(node: MemberKind, sourceNode: SourceNode) {
        shouldImportAssign = true;

        if (!isMemberKind(node)) {
            sourceNode.prepend(assignIdentifier + '(');
            sourceNode.add(')');

            return;
        }

        let parent = node.parent;
        let start = parent.getFullStart();

        sourceNode.children.length = 0;

        sourceNode.add(sourceText.substr(start, parent.getStart() - start));

        if (node.kind === ts.SyntaxKind.PropertyAccessExpression) {
            
            sourceNode.add(
                assignIdentifier + '(' +
                node.expression.getText() + ', ' +
                JSON.stringify(node.name.getText()) + ')'
            );

        } else if (node.kind === ts.SyntaxKind.ElementAccessExpression) {
            
            sourceNode.add(
                assignIdentifier + '(' +
                node.expression.getText() + ', ' +
                node.argumentExpression.getText() + ')'
            );
        }
    }

    function isMemberKind(node: ts.Node): node is MemberKind {
        return node.kind === ts.SyntaxKind.PropertyAccessExpression || node.kind === ts.SyntaxKind.ElementAccessExpression;
    }

    function createView(node: ts.StringLiteral, sourceNode: SourceNode) {
        let view = node.getText();
        
        sourceNode.children.length = 0;
        
        sourceNode.add(
            '() => new Promise(' +
                'resolve => require.ensure(' +
                    view + ', ' +
                    'require => resolve(require(' + view + ').default)' +
                ')' +
            ')'
        );
    }

    function createInject(node: ts.ClassDeclaration, sourceNode: SourceNode) {
        let inject: [string, string][] = [];

        ts.forEachChild(node, node => {
            node.kind === ts.SyntaxKind.PropertyDeclaration && storeInjection(<ts.PropertyDeclaration>node, inject);
        });

        if (!inject.length) {
            return;
        }

        appendProperty(
            node.name.getText() + '.inject',
            '{' + inject.map( injection => injection.join(':') ).join(',') + '}',
            sourceNode
        );
    }

    function createAttributes(node: ts.ClassDeclaration, sourceNode: SourceNode) {
        let attributes: [string, string][] = [];

        ts.forEachChild(node, node => {
            node.kind === ts.SyntaxKind.PropertyDeclaration && storeAttribute(<ts.PropertyDeclaration>node, attributes);
        });

        if (!attributes.length) {
            return;
        }

        appendProperty(
            node.name.getText() + '.attributes',
            '{' + attributes.map( attribute => attribute.join(':') ).join(',') + '}',
            sourceNode
        );
    }

    function createLocals(node: ts.ClassDeclaration, sourceNode: SourceNode) {
        let locals: string[] = [];

        ts.forEachChild(node, node => {
            node.kind === ts.SyntaxKind.PropertyDeclaration && storeLocal(<ts.PropertyDeclaration>node, locals);
        });

        if (!locals.length) {
            return;
        }

        appendProperty(
            node.name.getText() + '.locals',
            '[' + locals.join(',') + ']',
            sourceNode
        );
    }

    function appendProperty(property: string, value: string, sourceNode: SourceNode) {
        sourceNode.add(`${ property } = ${ property } ? Object.assign(${ property }, ${ value }) : ${ value };`);
    }

    function storeInjection(node: ts.PropertyDeclaration, inject: [string, string][]) {
        ts.forEachChild(node, childNode => {
            if (
                childNode.kind === ts.SyntaxKind.TypeReference &&
                matchInject.test(childNode.getFullText())
            ) {
                inject.push([
                    node.name.getText(),
                    childNode.getText()
                ]);
            }
        });
    }

    function storeAttribute(node: ts.PropertyDeclaration, attributes: [string, string][]) {
        let match = matchAttributeAccessor.exec(node.getText());

        if (!match) {
            return;
        }

        let type = match[1];
        let name = match[2];
        let key = node.name.getText() + (node.questionToken ? '?' : '');
        let value = attributeAccessors[type] + (name ? name.trim() : '');
        
        attributes.push([
            JSON.stringify(key),
            JSON.stringify(value)
        ]);
    }

    function storeLocal(node: ts.PropertyDeclaration, locals: string[]) {
        matchLocal.test(node.getText()) && locals.push(
            JSON.stringify(node.name.getText())
        );
    }

    function extendsClass(node: ts.ClassDeclaration, name: string, from: string) {
        if (!node.heritageClauses) {
            return;
        }

        for (let clause of node.heritageClauses) {
            if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
                continue;
            }

            let symbol = checker.getTypeAtLocation(clause.types[0].expression).symbol;
            let declaration = <ts.ClassDeclaration>symbol.valueDeclaration;

            if (symbol.name === name && declaration) {
                let fileName = declaration.getSourceFile().fileName;
                
                if (new RegExp('/node_modules/mahalo/' + from + '.ts$').test(fileName)) {
                    return true;
                }

                if (declaration.kind === ts.SyntaxKind.ClassDeclaration) {
                    return extendsClass(declaration, name, from);
                }
            }
            
            break;
        }
    }
}

export function clearCachedPrograms() {
    cachedPrograms.length = 0;
}

let cachedPrograms: ts.Program[] = [];

export function getProgram(fileName) {
    fileName = fileName.replace(/\\/g, '/');

    let program: ts.Program;

    cachedPrograms.forEach(cachedProgram => {
        cachedProgram && cachedProgram.getSourceFiles().forEach(sourceFile => {
            if (sourceFile.fileName === fileName) {
                program = cachedProgram;
            }
        });
    })

    if (!program) {
        cachedPrograms.length > 4 && cachedPrograms.shift();
        
        cachedPrograms.push(
            program = ts.createProgram([fileName], compilerOptions, createCompilerHost())
        );
    }

    return program;
}


//////////


function resolveModuleName(moduleName: string) {
    let file = ts.nodeModuleNameResolver(
        moduleName.replace(/\.ts$/, ''),
        '',
        compilerOptions,
        createCompilerHost()
    );

    if (!file) {
        throw Error('Cannot find module ' + moduleName);
    }
    
    return resolve(file.resolvedModule.resolvedFileName).replace(/\\/g, '/');
}

function createCompilerHost(): ts.CompilerHost {
    let host = ts.createCompilerHost(compilerOptions);
    
    host.realpath = path => /node_modules\/mahalo\//.test(path) ? path : ts.sys.realpath(path);
    host.getDefaultLibFileName = compilerOptions => join(dirname(ts.getDefaultLibFilePath(compilerOptions)), 'lib.es6.d.ts');

    return host;
}

type EditKind = ts.BinaryExpression|ts.PrefixUnaryExpression|ts.PostfixUnaryExpression|ts.DeleteExpression|ts.ClassDeclaration|ts.StringLiteral;

type MemberKind = ts.PropertyAccessExpression|ts.ElementAccessExpression;