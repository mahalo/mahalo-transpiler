#mahalo-transpiler
This module contains a TypeScript based transpiler for Mahalo applications.

## Installation
You should install this package as a development dependency like so:

```sh
npm install --save-dev mahalo-transpiler
```

##Usage

```javascript
import * as mahaloTranspiler from 'mahalo-transpiler';

var result: {text: string, map: string} = mahaloTranspiler('./module-name');
```