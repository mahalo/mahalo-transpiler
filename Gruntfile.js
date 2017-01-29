const fs = require('fs');
const ts = require('typescript');

module.exports = function(grunt) {
    grunt.registerTask('default', function() {
        let result = ts.transpileModule(fs.readFileSync('index.ts').toString(), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES5
            }
        });
        
        fs.writeFileSync('index.js', result.outputText);
    });
};