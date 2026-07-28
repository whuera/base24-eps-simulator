# Simulador ACI BASE24-eps (EPS Development - ESNCService)

Aplicación Node.js (Express + EJS + SQLite) que **replica las pantallas de configuración**
de la plataforma ACI BASE24-eps que aparecen en los manuales, e incluye un **motor de
simulación de transacciones** que reproduce el flujo real del switch: búsqueda de prefix →
resolución del issuer → aplicación del limit profile → ruteo a un destino Host/Interchange →
action code → journalización.

## Módulos incluidos (MVP)

| Módulo | Pantalla replicada | Ruta |
|---|---|---|
| Institution | Institution Configuration (BNK1 / FIRSTSTATEBANK) | `/institution` |
| Host / Interchange | VisaNet ISO Interface Configuration (VISA_BASE1) | `/host` |
| Prefix | On-Us / System Prefix Configuration (160107) | `/prefix` |
| Routing | Source Routing Profile (STAR_SRC) con grid de destinos | `/routing` |
| Transaction Simulator | System Operations → motor + journal | `/simulator` |

Cada pantalla imita el look de la consola de escritorio (Windows XP / Java Swing MDI):
barra de menú `File / Edit / Configure / System Operations / Customer Management / View / Window / Help`,
ventanas MDI con barra de título, toolbar, pestañas, grids y barra de estado.

## Requisitos

- Node.js 18 o superior (recomendado 20+).

## Cómo ejecutar

```bash
cd base24-eps-simulator
npm install
npm start
```

Luego abre <http://localhost:3000> en el navegador.

La base de datos SQLite se crea y se siembra sola en `db/base24eps.sqlite` la primera vez.
Para reiniciar los datos, borra ese archivo (y los `-wal` / `-shm`) y vuelve a arrancar.

## Cómo probar el simulador

1. Abre **System Operations → Transaction Simulator** (`/simulator`).
2. Prueba estos casos:
   - PAN `1601070000001234`, monto `120` → **On-Us**, aprobado `00`.
   - PAN `1601070000001234`, monto `800` → rechazo `61` (excede límite por transacción, LMT_STD = 500).
   - PAN `4000001234567890`, monto `50` → **Not-On-Us**, ruteado a `VISA_BASE1`.
   - PAN `9999...`, cualquier monto → `14` tarjeta inválida (sin prefix).
3. Revisa el **Journal** al pie para ver cada transacción registrada.

También hay un API JSON:

```bash
curl -X POST http://localhost:3000/api/authorize \
  -H "Content-Type: application/json" \
  -d '{"pan":"1601070000001234","amount":120,"txn_type":"Withdrawal","source":"ATM"}'
```

## Estructura

```
base24-eps-simulator/
├─ server.js            # rutas Express
├─ engine.js            # motor de autorización/ruteo
├─ db/database.js       # esquema SQLite + datos semilla
├─ views/               # plantillas EJS (shell + 4 módulos + simulador)
│  └─ partials/         # top.ejs / bottom.ejs (marco de la app)
├─ public/css/base24.css
└─ package.json
```

## Notas

- Es un simulador **didáctico**: los datos y la lógica de autorización son una aproximación
  de lo descrito en los manuales, no el producto real de ACI.
- Alcance actual: 4 módulos + motor. La arquitectura permite añadir los demás módulos
  (Limit Profile, Transaction Security, Journal, ATM/POS Device Handler, Customer Management)
  replicando el mismo patrón de ruta + vista.
