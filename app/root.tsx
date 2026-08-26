import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
} from "react-router";
import type { Route } from "./+types/root";
import "./styles.css";

export function Layout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta
					name="description"
					content="Downloadable KoLmafia Two Crazy Random Summer item-modifier data for every class and zodiac sign."
				/>
				<link rel="icon" type="image/png" href="/favicon.png" />
				<Meta />
				<Links />
			</head>
			<body>
				{children}
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
}

export default function App() {
	return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
	const message = isRouteErrorResponse(error)
		? `${error.status} ${error.statusText}`
		: error instanceof Error
			? error.message
			: "Unknown error";

	return (
		<main className="wrap">
			<h1>Something went wrong</h1>
			<p className="muted">{message}</p>
			<p>
				<a href="/">Back to the start</a>
			</p>
		</main>
	);
}
