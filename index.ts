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

const programs: ts.Program[] = [];
const matchAttributeAccessor = /:\s*\/\*\s*(get|eval|watch|bind)(\s*[a-z][a-z0-9-]*)?\s*\*\//;
const matchInject = /\/\*\s*inject\s*\*\//;
const attributeAccessors = {
    get: '',
    eval: '?',
    watch: '.',
    bind: ':'
};
const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES5,
    module: ts.ModuleKind.CommonJS,
    // moduleResolution: ts.ModuleResolutionKind.NodeJs,
    allowJs: true
};

export default function mahaloTranspiler(moduleName: string, shouldDiagnose = false) {
    let fileName = resolveModuleName(moduleName);
    let program = getProgram();
    let checker = program.getTypeChecker();
    let sourceFile = program.getSourceFile(fileName);
    let text = sourceFile.text;
    let edits: Change[] = [];
    let identifiers = [];
    let assignIdentifier = 'assign';
    let shouldImportAssign = false;
    let assignmentDepth = 0;
    let mahaloMap;
    
    shouldDiagnose && ts.getPreEmitDiagnostics(program, sourceFile).forEach(
        diagnostic => {
            if (diagnostic.category === ts.DiagnosticCategory.Error) {
                throw Error(diagnostic.messageText.toString());
            }
        }
    );

    if (!/\/node_modules\/(mahalo|core-js)\//.test(fileName)) {
        findIdentifiers(sourceFile);

        while (identifiers.indexOf(assignIdentifier) > -1) {
            assignIdentifier = '_' + assignIdentifier;
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


    function getProgram() {
        let program: ts.Program;

        programs.forEach(cachedProgram => {
            cachedProgram.getSourceFiles().forEach(sourceFile => {
                if (sourceFile.fileName === fileName) {
                    program = cachedProgram;
                }
            });
        });

        if (!program) {
            programs.push(
                program = ts.createProgram([fileName], compilerOptions, createCompilerHost())
            );
        }

        return program;
    }

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
                let _node = <ts.ClassDeclaration>node;

                if (extendsClass(_node, 'default', 'components/route')) {
                    createRouteEdit(_node);    
                }

                if (
                    extendsClass(_node, 'default', 'core/component') ||
                    extendsClass(_node, 'default', 'core/component')
                ) {
                    createInjectEdit(<ts.ClassDeclaration>node);
                }

                if (extendsClass(_node, 'default', 'core/component')) {
                    createAttributesEdit(<ts.ClassDeclaration>node);
                }

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
        for (let member of node.members) {
            if (member.name.getText() === 'view') {
                let initializer = <ts.StringLiteral>member['initializer'];

                if (initializer && initializer.kind === ts.SyntaxKind.StringLiteral) {
                    let view = initializer.text;
                    
                    edits.push({
                        start: initializer.getStart(),
                        length: initializer.getWidth(),
                        newText: `() => {
                            return new Promise(resolve => {
                                require.ensure(${JSON.stringify(view)}, require => {
                                    resolve(require(${JSON.stringify(view)}));
                                });
                            });
                        }`
                    });
                }
                
                return;
            }
        }
    }

    function createInjectEdit(node: ts.ClassDeclaration) {
        let inject: [string, string][] = [];
        let start: number;

        ts.forEachChild(node, node => {
            if (node.kind === ts.SyntaxKind.PropertyDeclaration) {
                start || (start = node.getFullStart());
                storeInjection(<ts.PropertyDeclaration>node, inject);
            }
        });

        if (!inject.length) {
            return;
        }

        let text = inject.map(
            injection => injection.join(':')
        ).join(',');

        edits.push({
            start: start,
            length: 0,
            newText: 'static inject = {' + text + '};'
        });
    }

    function createAttributesEdit(node: ts.ClassDeclaration) {
        let attributes: [string, string][] = [];
        let start: number;

        ts.forEachChild(node, node => {
            if (node.kind === ts.SyntaxKind.PropertyDeclaration) {
                start || (start = node.getFullStart());
                storeAttribute(<ts.PropertyDeclaration>node, attributes);
            }
        });

        if (!attributes.length) {
            return;
        }

        let text = attributes.map(
            attribute => attribute.join(':')
        ).join(',');

        edits.push({
            start: start,
            length: 0,
            newText: 'static attributes = {' + text + '};'
        });
    }

    function storeInjection(node: ts.PropertyDeclaration, inject: [string, string][]) {
        ts.forEachChild(node, childNode => {
            if (childNode.kind === ts.SyntaxKind.TypeReference) {
                if (matchInject.test(childNode.getFullText())) {
                    inject.push([
                        node.name.getText(),
                        childNode.getText()
                    ]);
                }
            }
        });
    }

    function storeAttribute(node: ts.PropertyDeclaration, attributes: [string, string][]) {
        let match = matchAttributeAccessor.exec(node.getText());

        if (!match) {
            return;
        }

        let type = attributeAccessors[match[1]];
        
        attributes.push([
            node.name.getText(),    
            "'" + type + (match[2] ? match[2].trim() : '') + "'"
        ]);
    }

    function extendsClass(node: ts.ClassDeclaration, name: string, from: string) {
        if (node.heritageClauses) {
            for (let clause of node.heritageClauses) {
                if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
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

        return false;
    }

    function importModules() {
        shouldImportAssign && edits.unshift({
            start: 0,
            length: 0,
            newText: "import {assign as " + assignIdentifier + "} from 'mahalo';\n"
        });
    }
}

export function clearPrograms() {
    programs.length = 0;
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
function mergeSourceMaps(mahaloMap: sourceMap.RawSourceMap, typescriptMap: sourceMap.RawSourceMap) {
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

const resolutionHost = {
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile
};

function createCompilerHost(): ts.CompilerHost {
    let host = ts.createCompilerHost(compilerOptions);
    
    host.resolveModuleNames = resolveModuleNames;

    return host;

    function resolveModuleNames(moduleNames: string[], containingFile: string): ts.ResolvedModule[] {
        return moduleNames.map(
            moduleName => ts.resolveModuleName(moduleName, containingFile, compilerOptions, resolutionHost).resolvedModule
        );
    }
}