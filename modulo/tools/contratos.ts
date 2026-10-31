// Las mismas herramientas que usa la aplicación: se re-exportan, no se copian.
// Cada export es una herramienta { description, args (zod), execute(args, ctx) } y la plataforma
// la expone como contratos_<export>. ctx.directory debe ser la raíz de este repositorio.
export * from "../../src/tools/contratos"
