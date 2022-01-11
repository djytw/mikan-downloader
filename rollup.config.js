
export default [
    {
        input: 'build/index.js',
        output: {
            file: 'dist/main.js',
            format: 'esm'
        },
        external: [
            'fs',
            'process',
            'node-fetch',
            'fast-xml-parser'
        ]
    }
]
