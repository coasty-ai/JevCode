process.stdout.write(`start ${process.stdout.columns}x${process.stdout.rows}\r\n`);
process.stdout.on('resize', () => process.stdout.write(`resize ${process.stdout.columns}x${process.stdout.rows}\r\n`));
setTimeout(() => process.exit(0), 4000);
