
export default [
    {
        input: 'build/index.js',
        output: {
            file: 'dist/main.js',
            format: 'esm'
        },
        external: [
            'fs',
            'node-fetch',
            'fast-xml-parser'
        ]
    }
]
